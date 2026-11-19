import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FileDiff, Thread, ThreadPlacement } from '../../src/shared/api.ts';
import {
    budgetedSource, compareVersions, fileSides, MAX_COMPARISON_BYTES, placeThreads, summarizeVersion, type CompareSource, type CompareVersion,
    type FileContent,
} from '../../src/server/core/compare.ts';
import { scenario } from '../support/fake-repo.ts';

const changed = (file: FileDiff): string[] => file.hunks.flatMap((h) => h.lines.filter((l) => l.t !== ' ').map((l) => `${l.t}${l.text.trim()}`));
const paths = (files: readonly FileDiff[]): string[] => files.map((f) => f.path);
const lineAnchor = (to: number): Thread['anchor'] => ({ to, from: null, startTo: null, startFrom: null });

/** Source with a single file modified between "old" and "new". */
function singleFile(path: string, contents: Record<string, FileContent>): CompareSource {
    return {
        diffstat: async (n, o) => (n === o ? [] : [{ status: 'modified', oldPath: path, newPath: path, added: 1, removed: 1 }]),
        content: async (hash) => contents[hash] ?? { missing: true },
    };
}

const oneVersion: CompareVersion[] = [{ index: 1, hash: 'new', base: 'old', message: '', isRebase: false, messageChanged: false }];

describe('compareVersions', () => {
    it('amend without rebase: only the author\'s change shows up', async () => {
        const { repo, versions } = scenario();
        const result = await compareVersions(repo.source(), versions, 1, 2);
        expect(paths(result.files)).toEqual(['src/Action.ts']);
        expect(changed(result.files[0]!)).toEqual(['-const id = data.labels?.slug ?? data.id;', '+const id = this.repo.buildIdFromPayload(data);']);
        expect(result.masterOnly).toEqual([]);
    });

    it('pure rebase: no file, master\'s changes are hidden (lockfile included)', async () => {
        const { repo, versions } = scenario();
        const result = await compareVersions(repo.source(), versions, 2, 3);
        expect(result.files).toEqual([]);
        expect(result.masterOnly).toEqual(['changelog.md', 'package-lock.json', 'src/Other.ts']);
    });

    it('across a rebase: only the author\'s RC bump stays in the lockfile', async () => {
        const { repo, versions } = scenario();
        const result = await compareVersions(repo.source(), versions, 2, 4);
        expect(paths(result.files)).toEqual(['package-lock.json']);
        expect(result.files[0]!.category).toBe('deps');
        expect(changed(result.files[0]!)).toEqual(['-"c": "1.0.0-rc.1",', '+"c": "1.0.0-rc.2",']);
        expect(result.masterOnly).toEqual(['changelog.md', 'src/Other.ts']);
    });

    it('several versions and two rebases: author\'s code + deps, master filtered out', async () => {
        const { repo, versions } = scenario();
        const result = await compareVersions(repo.source(), versions, 1, 5);
        expect(paths(result.files)).toEqual(['src/Action.ts', 'package-lock.json']);
        expect(changed(result.files[0]!)).toEqual([
            '-const id = data.labels?.slug ?? data.id;',
            '+const id = this.repo.buildIdFromPayload(data);',
            '-return this.save(id);',
            '+return this.repo.save(id);',
        ]);
        expect(changed(result.files[1]!)).toEqual(['-"c": "1.0.0-rc.1",', '+"c": "1.0.0-rc.2",']);
        expect(result.masterOnly).toEqual(expect.arrayContaining(['src/Third.ts', 'changelog.md']));
    });

    it('full version against its base (from = 0)', async () => {
        const { repo, versions } = scenario();
        const result = await compareVersions(repo.source(), versions, 0, 2);
        expect(result.files.map((f) => `${f.status}:${f.path}`)).toEqual(['modified:src/Action.ts', 'added:tests/ActionSpec.ts', 'modified:package-lock.json']);
        expect(result.stats.files).toBe(3);
        expect(result.messageChanged).toBe(false);
    });

    it('message-only change detected', async () => {
        const { repo, versions } = scenario();
        const result = await compareVersions(repo.source(), versions, 5, 6);
        expect(result.files).toEqual([]);
        expect(result.messageChanged).toBe(true);
    });

    it('final newline added: the last line shows as modified (like git)', async () => {
        const src = singleFile('a.ts', { old: { text: 'l1\nl2' }, new: { text: 'l1\nl2\nl3\n' } });
        const [file] = (await compareVersions(src, oneVersion, 0, 1)).files;
        expect([file!.added, file!.removed]).toEqual([2, 1]);
        expect(file!.hunks[0]!.lines.find((l) => l.t === '-')).toMatchObject({ text: 'l2', noEol: true });
        expect(file!.hunks[0]!.lines.every((l) => !l.text.includes('\u0000'))).toBe(true);
    });

    it('a Vue hunk inside <script setup> carries the block\'s opening tag on each side, the whole file none', async () => {
        const sfc = (limit: number): string => [
            '<template>', '    <p>{{ limit }}</p>', '</template>', '', '<script setup lang="ts">', "import { ref } from 'vue';", '',
            'const first = 1;', 'const second = 2;', `const limit = ref<number>(${limit});`, '</script>', '',
        ].join('\n');
        const contents = { old: { text: sfc(20) }, new: { text: sfc(50) } };
        const [vue] = (await compareVersions(singleFile('src/components/RecordList.vue', contents), oneVersion, 0, 1)).files;
        expect(vue!.hunks.map((h) => [h.newStart, h.leadIn])).toEqual([[7, { old: '<script setup lang="ts">', new: '<script setup lang="ts">' }]]);
        const [whole] = (await compareVersions(singleFile('src/components/RecordList.vue', contents), oneVersion, 0, 1, { context: 1_000_000 })).files;
        expect(whole!.hunks.map((h) => [h.newStart, 'leadIn' in h])).toEqual([[1, false]]);
        // another kind of file: no lead-in key at all (smaller payload)
        const [ts] = (await compareVersions(singleFile('src/components/RecordList.ts', contents), oneVersion, 0, 1)).files;
        expect(ts!.hunks.map((h) => 'leadIn' in h)).toEqual([false]);
    });

    it('files follow the explorer order (folders first), code before dependencies', async () => {
        const order = ['src/z.ts', 'package-lock.json', 'README.md', 'src/core/a.ts', 'src/a.ts', 'docs/x.md'];
        const src: CompareSource = {
            diffstat: async () => order.map((path) => ({ status: 'modified', oldPath: path, newPath: path, added: 1, removed: 1 })),
            content: async (hash, path) => ({ text: `${hash} ${path}\n` }),
        };
        const result = await compareVersions(src, oneVersion, 0, 1);
        expect(paths(result.files)).toEqual(['docs/x.md', 'src/core/a.ts', 'src/a.ts', 'src/z.ts', 'README.md', 'package-lock.json']);
    });

    it('submodule: grouped with the dependencies', async () => {
        const src = singleFile('shared-submodule', {
            old: { text: `Subproject commit ${'a'.repeat(40)}\n`, submodule: true },
            new: { text: `Subproject commit ${'b'.repeat(40)}\n`, submodule: true },
        });
        const [file] = (await compareVersions(src, oneVersion, 0, 1)).files;
        expect(file).toMatchObject({ category: 'deps', added: 1, removed: 1 });
    });

    it('huge file across a rebase: marked too large, the comparison does not break', async () => {
        const huge = (tag: string): FileContent => ({ text: `${Array.from({ length: 70000 }, (_, i) => `"x${i}": "${tag}",`).join('\n')}\n` });
        const src = singleFile('package-lock.json', { b1: huge('a'), v1: huge('b'), b2: huge('c'), v2: huge('d') });
        const versions: CompareVersion[] = [
            { index: 1, hash: 'v1', base: 'b1', message: '', isRebase: false, messageChanged: false },
            { index: 2, hash: 'v2', base: 'b2', message: '', isRebase: true, messageChanged: false },
        ];
        const result = await compareVersions(src, versions, 1, 2);
        expect(result.files).toHaveLength(1);
        expect(result.files[0]!.tooLarge).toBe(true);
    });

    describe('binary or too large across a rebase (fingerprint)', () => {
        const image = (flag: 'binary' | 'tooLarge', fingerprint?: string): FileContent =>
            (flag === 'binary' ? { binary: true, fingerprint } : { tooLarge: true, fingerprint });
        const rebased: CompareVersion[] = [
            { index: 1, hash: 'v1', base: 'b1', message: '', isRebase: false, messageChanged: false },
            { index: 2, hash: 'v2', base: 'b2', message: '', isRebase: true, messageChanged: false },
        ];

        it.each(['binary', 'tooLarge'] as const)('%s identical on both sides of the rebase: no author change', async (flag) => {
            // The author modified the image in v1; master changed it between b1 and b2; v2 keeps the author's image.
            const src = singleFile('logo.png', { b1: image(flag, 'master-1'), v1: image(flag, 'auteur'), b2: image(flag, 'master-2'), v2: image(flag, 'auteur') });
            const result = await compareVersions(src, rebased, 1, 2);
            expect(result.files).toEqual([]);
            expect(result.masterOnly).toEqual(['logo.png']);
            expect((await summarizeVersion(src, rebased, 2)).kind).toBe('rebase-only');
        });

        it('image changed only by master between the two bases: replayed, no author change', async () => {
            const src = singleFile('logo.png', { b1: image('binary', 'master-1'), v1: image('binary', 'master-1'), b2: image('binary', 'master-2'), v2: image('binary', 'master-2') });
            expect((await compareVersions(src, rebased, 1, 2)).files).toEqual([]);
        });

        it('binary really modified by the author: change', async () => {
            const src = singleFile('logo.png', { b1: image('binary', 'master-1'), v1: image('binary', 'auteur-1'), b2: image('binary', 'master-2'), v2: image('binary', 'auteur-2') });
            const result = await compareVersions(src, rebased, 1, 2);
            expect(result.files).toHaveLength(1);
            expect(result.files[0]).toMatchObject({ path: 'logo.png', binary: true, tooLarge: false });
            expect((await summarizeVersion(src, rebased, 2)).kind).toBe('code');
        });

        it.each([
            ['binary', { binary: true, fingerprint: 'same' }],
            ['too large', { tooLarge: true, fingerprint: 'same' }],
            ['huge text', { text: `${Array.from({ length: 70000 }, (_, i) => `l${i}`).join('\n')}\n` }],
        ] as [string, FileContent][])('%s renamed without content change: stays listed as renamed', async (_, content) => {
            const src: CompareSource = {
                diffstat: async (n, o) => (n === o ? [] : [{ status: 'renamed', oldPath: 'logo.png', newPath: 'assets/logo.png', added: 0, removed: 0 }]),
                content: async (hash, path) => ((hash === 'v1' && path === 'logo.png') || (hash === 'v2' && path === 'assets/logo.png') ? content : { missing: true }),
            };
            const sameBase: CompareVersion[] = [
                { index: 1, hash: 'v1', base: 'b', message: '', isRebase: false, messageChanged: false },
                { index: 2, hash: 'v2', base: 'b', message: '', isRebase: false, messageChanged: false },
            ];
            const result = await compareVersions(src, sameBase, 1, 2);
            expect(result.files.map((f) => [f.status, f.oldPath, f.path])).toEqual([['renamed', 'logo.png', 'assets/logo.png']]);
            expect((await summarizeVersion(src, sameBase, 2)).kind).toBe('code');
        });

        it('cache entries without fingerprint (old ones): never judged equal, as before', async () => {
            const src = singleFile('logo.png', { b1: image('binary'), v1: image('binary'), b2: image('binary'), v2: image('binary') });
            expect(paths((await compareVersions(src, rebased, 1, 2)).files)).toEqual(['logo.png']);
        });
    });

    it('invalid comparison rejected', async () => {
        const { repo, versions } = scenario();
        await expect(compareVersions(repo.source(), versions, 3, 2)).rejects.toThrow('Comparaison invalide');
    });

    it('the content cache is used sparingly', async () => {
        const { repo, versions } = scenario();
        await compareVersions(repo.source(), versions, 2, 3);
        expect(repo.calls.content).toBeLessThanOrEqual(12);
    });
});

describe('per-comparison content cap', () => {
    const many = (names: string[], size: number): CompareSource => ({
        diffstat: async () => names.map((n) => ({ status: 'added' as const, oldPath: null, newPath: n, added: 1, removed: 0 })),
        content: async (hash, path) => (hash === 'new' ? { text: `${path}${'x'.repeat(size)}` } : { missing: true }),
    });

    it('marks the files beyond the byte cap as too large, like a huge file', async () => {
        const { files } = await compareVersions(many(['a.ts', 'b.ts', 'c.ts'], 100), oneVersion, 0, 1, { maxBytes: 250 });
        expect(files.map((f) => [f.path, f.tooLarge])).toEqual([['a.ts', false], ['b.ts', false], ['c.ts', true]]);
    });

    it('refuses the tail of the file order even when the fetches resolve out of order', async () => {
        const gates = new Map<string, () => void>();
        const src: CompareSource = {
            diffstat: async () => ['a.ts', 'b.ts', 'c.ts'].map((n) => ({ status: 'added' as const, oldPath: null, newPath: n, added: 1, removed: 0 })),
            content: (hash, path) => (hash === 'new'
                ? new Promise((resolve) => { gates.set(path, () => resolve({ text: 'x'.repeat(100) })); })
                : Promise.resolve({ missing: true as const })),
        };
        const running = compareVersions(src, oneVersion, 0, 1, { maxBytes: 250 });
        await new Promise((r) => setTimeout(r, 0));
        ['c.ts', 'a.ts', 'b.ts'].forEach((n) => gates.get(n)!());
        expect((await running).files.map((f) => [f.path, f.tooLarge])).toEqual([['a.ts', false], ['b.ts', false], ['c.ts', true]]);
    });

    it('answers the same way when a key is requested again', async () => {
        const src = budgetedSource({ diffstat: async () => [], content: async (hash) => ({ text: 'x'.repeat(100) + hash }) }, 250);
        const first = await src.content('h1', 'p');
        await src.content('h2', 'p');
        await src.content('h3', 'p');
        expect(await src.content('h1', 'p')).toBe(first);
        expect('text' in first).toBe(true);
        // the content's fingerprint: the same text compares equal past the cap, as a huge file does
        expect(await src.content('h3', 'p')).toEqual({ tooLarge: true, fingerprint: createHash('sha1').update(`${'x'.repeat(100)}h3`).digest('hex') });
    });

    const rebased: CompareVersion[] = [
        { index: 1, hash: 'v1', base: 'b1', message: '', isRebase: false, messageChanged: false },
        { index: 2, hash: 'v2', base: 'b2', message: '', isRebase: true, messageChanged: false },
    ];

    it('a file the rebase left as the author wrote it stays in "master only" past the cap', async () => {
        const text = (label: string): FileContent => ({ text: `${label}\n${'x'.repeat(100)}\n` });
        const src = singleFile('big.ts', { b1: text('master-1'), v1: text('author'), b2: text('master-2'), v2: text('author') });
        const result = await compareVersions(src, rebased, 1, 2, { maxBytes: 50 });
        expect(result.files).toEqual([]);
        expect(result.masterOnly).toEqual(['big.ts']);
    });

    it('the same content on both sides of the cap compares equal', async () => {
        // a mode change: listed by the diffstat, same content; the old side fits under the cap, the new one does not
        const same = { text: `${'x'.repeat(100)}\n` };
        const src = singleFile('run.sh', { v1: same, v2: same });
        const sameBase: CompareVersion[] = rebased.map((v) => ({ ...v, base: 'b', isRebase: false }));
        const result = await compareVersions(src, sameBase, 1, 2, { maxBytes: 150 });
        expect(result.files).toEqual([]);
        expect(result.masterOnly).toEqual(['run.sh']);
    });

    it('version summaries are not capped: a rebase-only version with contents past the cap is still "rebase only"', async () => {
        // master and the author changed different lines of the file: only the 3-way merge (text) shows no author change
        const big = 'x'.repeat(Math.ceil(MAX_COMPARISON_BYTES / 3));
        const file = (first: string, last: string): FileContent => ({ text: `${first}\n${big}\n${last}\n` });
        const src = singleFile('data.ts', { b1: file('a', 'c'), v1: file('a2', 'c'), b2: file('a', 'c2'), v2: file('a2', 'c2') });
        expect((await summarizeVersion(src, rebased, 2)).kind).toBe('rebase-only');
    });

    it('keeps everything under the cap', async () => {
        const { files } = await compareVersions(many(['a.ts', 'b.ts'], 100), oneVersion, 0, 1, { maxBytes: 1000 });
        expect(files.every((f) => !f.tooLarge)).toBe(true);
    });
});

describe('summarizeVersion', () => {
    it('types: creation, code, rebase only, deps, code, message only', async () => {
        const { repo, versions } = scenario();
        const src = repo.source();
        const summaries = await Promise.all(versions.map((v) => summarizeVersion(src, versions, v.index)));
        expect(summaries.map((s) => s.kind)).toEqual(['creation', 'code', 'rebase-only', 'deps', 'code', 'message-only']);
        expect(summaries[3]).toMatchObject({ added: 1, removed: 1 });
        expect(summaries[2]!.masterFiles).toBe(3);
    });
});

describe('placeThreads', () => {
    it('relocates the threads and detects lines modified since', async () => {
        const { repo, versions } = scenario();
        const src = repo.source();
        const result = await compareVersions(src, versions, 2, 5);
        await placeThreads(src, versions, result, [
            { id: 1, path: 'src/Action.ts', anchor: lineAnchor(3), version: 2 }, // id line, unchanged since v2
            { id: 2, path: 'src/Action.ts', anchor: lineAnchor(7), version: 2 }, // return this.save → modified in v5
            { id: 3, path: 'src/Action.ts', anchor: lineAnchor(1), version: 5 }, // posted on v5
            { id: 4, path: 'src/Other.ts', anchor: lineAnchor(1), version: 2 }, // file absent from the comparison
            { id: 5, path: null, anchor: null, version: 2 }, // general comment
        ]);
        expect(result.files.find((f) => f.path === 'src/Action.ts')!.threads).toEqual([
            { threadId: 3, line: 1, startLine: null, moved: false, outOfHunks: true },
            { threadId: 1, line: 3, startLine: null, moved: false, outOfHunks: true },
            { threadId: 2, line: 7, startLine: null, moved: true, outOfHunks: false },
        ]);
    });

    describe('multi-line comments (range start mapped like the end line)', () => {
        const OLD = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        // v1 -> v2: one line inserted at the top, "c" and "d" removed, "f" modified
        const NEW = ['top', 'a', 'b', 'e', 'f2', 'g', 'h'];
        const contents: Record<string, FileContent> = { v1: { text: `${OLD.join('\n')}\n` }, v2: { text: `${NEW.join('\n')}\n` } };
        const src: CompareSource = {
            diffstat: async () => [{ status: 'modified', oldPath: 'r.ts', newPath: 'r.ts', added: 2, removed: 3 }],
            content: async (hash) => contents[hash] ?? { missing: true },
        };
        const version = (index: number): CompareVersion => ({ index, hash: `v${index}`, base: 'base', message: '', isRebase: false, messageChanged: false });
        const versions = [version(1), version(2)];
        const rangeAnchor = (startTo: number, to: number): Thread['anchor'] => ({ to, from: null, startTo, startFrom: null });
        const placed = async (threads: Parameters<typeof placeThreads>[3]): Promise<ThreadPlacement[]> =>
            (await placeThreads(src, versions, await compareVersions(src, versions, 1, 2), threads)).files[0]!.threads;

        it('posted on the shown version: the range as written', async () => {
            expect(await placed([{ id: 1, path: 'r.ts', anchor: rangeAnchor(2, 5), version: 2 }]))
                .toEqual([{ threadId: 1, line: 5, startLine: 2, moved: false, outOfHunks: false }]);
        });

        it('posted on an older version: start and end mapped; a changed start or end counts as moved', async () => {
            expect(await placed([
                { id: 1, path: 'r.ts', anchor: rangeAnchor(1, 2), version: 1 }, // a..b, unchanged
                { id: 2, path: 'r.ts', anchor: rangeAnchor(3, 7), version: 1 }, // c (removed)..g: start on the closest line
                { id: 3, path: 'r.ts', anchor: rangeAnchor(2, 6), version: 1 }, // b..f (modified end)
            ])).toEqual([
                { threadId: 1, line: 3, startLine: 2, moved: false, outOfHunks: false },
                { threadId: 3, line: 5, startLine: 3, moved: true, outOfHunks: false },
                { threadId: 2, line: 6, startLine: 4, moved: true, outOfHunks: false },
            ]);
        });

        it('a start that cannot be mapped before the end: shown at its end line, as a single line', async () => {
            // c..d both removed: start and end land on the same line
            expect(await placed([{ id: 1, path: 'r.ts', anchor: rangeAnchor(3, 4), version: 1 }]))
                .toEqual([{ threadId: 1, line: 4, startLine: null, moved: true, outOfHunks: false }]);
        });

        it('an anchor without range fields (detail cached by an older version): a single line', async () => {
            const legacy = { to: 5, from: null } as unknown as Thread['anchor'];
            expect(await placed([{ id: 1, path: 'r.ts', anchor: legacy, version: 2 }]))
                .toEqual([{ threadId: 1, line: 5, startLine: null, moved: false, outOfHunks: false }]);
        });
    });
});

describe('fileSides (VS Code diff editor)', () => {
    it('across a rebase, the old side is A replayed onto B\'s base (like the comparison)', async () => {
        const { repo, versions } = scenario();
        const { oldText, newText } = await fileSides(repo.source(), versions, 2, 4, { path: 'package-lock.json', oldPath: null });
        expect(oldText).toContain('"a": "1.1.0"');
        expect(oldText).toContain('"c": "1.0.0-rc.1"');
        expect(newText).toContain('"c": "1.0.0-rc.2"');
        expect(oldText.split('\n').filter((l, i) => l !== newText.split('\n')[i])).toEqual(['    "c": "1.0.0-rc.1",']);
    });

    it('full version against its base: added file empty on the left', async () => {
        const { repo, versions } = scenario();
        const { oldText, newText } = await fileSides(repo.source(), versions, 0, 2, { path: 'tests/ActionSpec.ts', oldPath: null });
        expect(oldText).toBe('');
        expect(newText.split('\n').slice(0, 4)).toEqual(['import { Action } from \'../src/Action\';', 'import { buildPayload } from \'./helpers\';', '', 'describe("Action", () => {']);
        expect(newText.endsWith('    });\n});\n')).toBe(true);
    });

    it('restores the absence of a final newline', async () => {
        const src = singleFile('a.ts', { old: { text: 'l1\nl2' }, new: { text: 'l1\nl2\nl3\n' } });
        expect(await fileSides(src, oneVersion, 0, 1, { path: 'a.ts', oldPath: null })).toEqual({ oldText: 'l1\nl2', newText: 'l1\nl2\nl3\n' });
    });
});
