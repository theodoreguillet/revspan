import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../src/shared/api.ts';
import {
    compareVersions, fileSides, placeThreads, summarizeVersion, type CompareSource, type CompareVersion, type FileContent,
} from '../../src/server/core/compare.ts';
import { scenario } from '../support/fake-repo.ts';

const changed = (file: FileDiff): string[] => file.hunks.flatMap((h) => h.lines.filter((l) => l.t !== ' ').map((l) => `${l.t}${l.text.trim()}`));
const paths = (files: readonly FileDiff[]): string[] => files.map((f) => f.path);

/** Source à un seul fichier modifié entre « old » et « new ». */
function singleFile(path: string, contents: Record<string, FileContent>): CompareSource {
    return {
        diffstat: async (n, o) => (n === o ? [] : [{ status: 'modified', oldPath: path, newPath: path, added: 1, removed: 1 }]),
        content: async (hash) => contents[hash] ?? { missing: true },
    };
}

const oneVersion: CompareVersion[] = [{ index: 1, hash: 'new', base: 'old', message: '', isRebase: false, messageChanged: false }];

describe('compareVersions', () => {
    it('amend sans rebase : seul le changement de l\'auteur apparaît', async () => {
        const { repo, versions } = scenario();
        const result = await compareVersions(repo.source(), versions, 1, 2);
        expect(paths(result.files)).toEqual(['src/Action.ts']);
        expect(changed(result.files[0]!)).toEqual(['-const id = data.labels?.slug ?? data.id;', '+const id = this.repo.buildIdFromPayload(data);']);
        expect(result.masterOnly).toEqual([]);
    });

    it('rebase pur : aucun fichier, les changements de master sont masqués (lockfile compris)', async () => {
        const { repo, versions } = scenario();
        const result = await compareVersions(repo.source(), versions, 2, 3);
        expect(result.files).toEqual([]);
        expect(result.masterOnly).toEqual(['changelog.md', 'package-lock.json', 'src/Other.ts']);
    });

    it('à travers un rebase : seule la montée de RC de l\'auteur reste dans le lockfile', async () => {
        const { repo, versions } = scenario();
        const result = await compareVersions(repo.source(), versions, 2, 4);
        expect(paths(result.files)).toEqual(['package-lock.json']);
        expect(result.files[0]!.category).toBe('deps');
        expect(changed(result.files[0]!)).toEqual(['-"c": "1.0.0-rc.1",', '+"c": "1.0.0-rc.2",']);
        expect(result.masterOnly).toEqual(['changelog.md', 'src/Other.ts']);
    });

    it('plusieurs versions et deux rebases : code + deps de l\'auteur, master filtré', async () => {
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

    it('version complète contre sa base (from = 0)', async () => {
        const { repo, versions } = scenario();
        const result = await compareVersions(repo.source(), versions, 0, 2);
        expect(result.files.map((f) => `${f.status}:${f.path}`)).toEqual(['modified:src/Action.ts', 'added:tests/ActionSpec.ts', 'modified:package-lock.json']);
        expect(result.stats.files).toBe(3);
        expect(result.messageChanged).toBe(false);
    });

    it('changement de message seul détecté', async () => {
        const { repo, versions } = scenario();
        const result = await compareVersions(repo.source(), versions, 5, 6);
        expect(result.files).toEqual([]);
        expect(result.messageChanged).toBe(true);
    });

    it('retour à la ligne final ajouté : la dernière ligne apparaît modifiée (comme git)', async () => {
        const src = singleFile('a.ts', { old: { text: 'l1\nl2' }, new: { text: 'l1\nl2\nl3\n' } });
        const [file] = (await compareVersions(src, oneVersion, 0, 1)).files;
        expect([file!.added, file!.removed]).toEqual([2, 1]);
        expect(file!.hunks[0]!.lines.find((l) => l.t === '-')).toMatchObject({ text: 'l2', noEol: true });
        expect(file!.hunks[0]!.lines.every((l) => !l.text.includes('\u0000'))).toBe(true);
    });

    it('sous-module : rangé dans les dépendances', async () => {
        const src = singleFile('shared-submodule', {
            old: { text: `Subproject commit ${'a'.repeat(40)}\n`, submodule: true },
            new: { text: `Subproject commit ${'b'.repeat(40)}\n`, submodule: true },
        });
        const [file] = (await compareVersions(src, oneVersion, 0, 1)).files;
        expect(file).toMatchObject({ category: 'deps', added: 1, removed: 1 });
    });

    it('fichier énorme à travers un rebase : marqué trop gros, la comparaison ne casse pas', async () => {
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

    describe('binaire ou trop gros à travers un rebase (empreinte)', () => {
        const image = (flag: 'binary' | 'tooLarge', fingerprint?: string): FileContent =>
            (flag === 'binary' ? { binary: true, fingerprint } : { tooLarge: true, fingerprint });
        const rebased: CompareVersion[] = [
            { index: 1, hash: 'v1', base: 'b1', message: '', isRebase: false, messageChanged: false },
            { index: 2, hash: 'v2', base: 'b2', message: '', isRebase: true, messageChanged: false },
        ];

        it.each(['binary', 'tooLarge'] as const)('%s identique de part et d\'autre du rebase : aucun changement de l\'auteur', async (flag) => {
            // L'auteur a modifié l'image en v1 ; master l'a changée entre b1 et b2 ; v2 garde l'image de l'auteur.
            const src = singleFile('logo.png', { b1: image(flag, 'master-1'), v1: image(flag, 'auteur'), b2: image(flag, 'master-2'), v2: image(flag, 'auteur') });
            const result = await compareVersions(src, rebased, 1, 2);
            expect(result.files).toEqual([]);
            expect(result.masterOnly).toEqual(['logo.png']);
            expect((await summarizeVersion(src, rebased, 2)).kind).toBe('rebase-only');
        });

        it('image changée seulement par master entre les deux bases : rejouée, aucun changement de l\'auteur', async () => {
            const src = singleFile('logo.png', { b1: image('binary', 'master-1'), v1: image('binary', 'master-1'), b2: image('binary', 'master-2'), v2: image('binary', 'master-2') });
            expect((await compareVersions(src, rebased, 1, 2)).files).toEqual([]);
        });

        it('binaire réellement modifié par l\'auteur : changement', async () => {
            const src = singleFile('logo.png', { b1: image('binary', 'master-1'), v1: image('binary', 'auteur-1'), b2: image('binary', 'master-2'), v2: image('binary', 'auteur-2') });
            const result = await compareVersions(src, rebased, 1, 2);
            expect(result.files).toHaveLength(1);
            expect(result.files[0]).toMatchObject({ path: 'logo.png', binary: true, tooLarge: false });
            expect((await summarizeVersion(src, rebased, 2)).kind).toBe('code');
        });

        it('entrées de cache sans empreinte (anciennes) : jamais jugées égales, comme avant', async () => {
            const src = singleFile('logo.png', { b1: image('binary'), v1: image('binary'), b2: image('binary'), v2: image('binary') });
            expect(paths((await compareVersions(src, rebased, 1, 2)).files)).toEqual(['logo.png']);
        });
    });

    it('comparaison invalide refusée', async () => {
        const { repo, versions } = scenario();
        await expect(compareVersions(repo.source(), versions, 3, 2)).rejects.toThrow('Comparaison invalide');
    });

    it('le cache de contenu est sollicité avec parcimonie', async () => {
        const { repo, versions } = scenario();
        await compareVersions(repo.source(), versions, 2, 3);
        expect(repo.calls.content).toBeLessThanOrEqual(12);
    });
});

describe('summarizeVersion', () => {
    it('types : création, code, rebase seul, deps, code, message seul', async () => {
        const { repo, versions } = scenario();
        const src = repo.source();
        const summaries = await Promise.all(versions.map((v) => summarizeVersion(src, versions, v.index)));
        expect(summaries.map((s) => s.kind)).toEqual(['creation', 'code', 'rebase-only', 'deps', 'code', 'message-only']);
        expect(summaries[3]).toMatchObject({ added: 1, removed: 1 });
        expect(summaries[2]!.masterFiles).toBe(3);
    });
});

describe('placeThreads', () => {
    it('relocalise les fils et détecte les lignes modifiées depuis', async () => {
        const { repo, versions } = scenario();
        const src = repo.source();
        const result = await compareVersions(src, versions, 2, 5);
        await placeThreads(src, versions, result, [
            { id: 1, path: 'src/Action.ts', anchor: { to: 3, from: null }, version: 2 }, // ligne de l'id, inchangée depuis v2
            { id: 2, path: 'src/Action.ts', anchor: { to: 7, from: null }, version: 2 }, // return this.save → modifiée en v5
            { id: 3, path: 'src/Action.ts', anchor: { to: 1, from: null }, version: 5 }, // posté sur v5
            { id: 4, path: 'src/Other.ts', anchor: { to: 1, from: null }, version: 2 }, // fichier absent de la comparaison
            { id: 5, path: null, anchor: null, version: 2 }, // commentaire général
        ]);
        expect(result.files.find((f) => f.path === 'src/Action.ts')!.threads).toEqual([
            { threadId: 3, line: 1, moved: false, outOfHunks: true },
            { threadId: 1, line: 3, moved: false, outOfHunks: true },
            { threadId: 2, line: 7, moved: true, outOfHunks: false },
        ]);
    });
});

describe('fileSides (éditeur de diff de VS Code)', () => {
    it('à travers un rebase, le côté ancien est A rejouée sur la base de B (comme la comparaison)', async () => {
        const { repo, versions } = scenario();
        const { oldText, newText } = await fileSides(repo.source(), versions, 2, 4, { path: 'package-lock.json', oldPath: null });
        expect(oldText).toContain('"a": "1.1.0"');
        expect(oldText).toContain('"c": "1.0.0-rc.1"');
        expect(newText).toContain('"c": "1.0.0-rc.2"');
        expect(oldText.split('\n').filter((l, i) => l !== newText.split('\n')[i])).toEqual(['    "c": "1.0.0-rc.1",']);
    });

    it('version complète contre sa base : fichier ajouté vide à gauche', async () => {
        const { repo, versions } = scenario();
        const { oldText, newText } = await fileSides(repo.source(), versions, 0, 2, { path: 'tests/ActionSpec.ts', oldPath: null });
        expect(oldText).toBe('');
        expect(newText).toBe('describe("Action", () => {});\n');
    });

    it('restitue l\'absence de retour à la ligne final', async () => {
        const src = singleFile('a.ts', { old: { text: 'l1\nl2' }, new: { text: 'l1\nl2\nl3\n' } });
        expect(await fileSides(src, oneVersion, 0, 1, { path: 'a.ts', oldPath: null })).toEqual({ oldText: 'l1\nl2', newText: 'l1\nl2\nl3\n' });
    });
});
