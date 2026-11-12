import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../src/shared/api.ts';
import {
    compareVersions, fileSides, placeThreads, summarizeVersion, type CompareSource, type CompareVersion, type FileContent,
} from '../../src/server/core/compare.ts';
import { scenario } from '../support/fake-repo.ts';

const changed = (file: FileDiff): string[] => file.hunks.flatMap((h) => h.lines.filter((l) => l.t !== ' ').map((l) => `${l.t}${l.text.trim()}`));
const paths = (files: readonly FileDiff[]): string[] => files.map((f) => f.path);

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
            { id: 1, path: 'src/Action.ts', anchor: { to: 3, from: null }, version: 2 }, // id line, unchanged since v2
            { id: 2, path: 'src/Action.ts', anchor: { to: 7, from: null }, version: 2 }, // return this.save → modified in v5
            { id: 3, path: 'src/Action.ts', anchor: { to: 1, from: null }, version: 5 }, // posted on v5
            { id: 4, path: 'src/Other.ts', anchor: { to: 1, from: null }, version: 2 }, // file absent from the comparison
            { id: 5, path: null, anchor: null, version: 2 }, // general comment
        ]);
        expect(result.files.find((f) => f.path === 'src/Action.ts')!.threads).toEqual([
            { threadId: 3, line: 1, moved: false, outOfHunks: true },
            { threadId: 1, line: 3, moved: false, outOfHunks: true },
            { threadId: 2, line: 7, moved: true, outOfHunks: false },
        ]);
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
        expect(newText).toBe('describe("Action", () => {});\n');
    });

    it('restores the absence of a final newline', async () => {
        const src = singleFile('a.ts', { old: { text: 'l1\nl2' }, new: { text: 'l1\nl2\nl3\n' } });
        expect(await fileSides(src, oneVersion, 0, 1, { path: 'a.ts', oldPath: null })).toEqual({ oldText: 'l1\nl2', newText: 'l1\nl2\nl3\n' });
    });
});
