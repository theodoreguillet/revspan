import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Home, PrCard } from '../../src/shared/api.ts';
import { buildWebviewHtml, contentSecurityPolicy } from '../../src/extension/lib/webview-html.ts';
import { currentBranch, findLocalRepo, type RepoFs } from '../../src/extension/lib/repo-path.ts';
import { decodeDiffDocument, diffTitle, encodeDiffDocument } from '../../src/extension/lib/diff-uri.ts';
import { buildHomeTree } from '../../src/extension/lib/home-tree.ts';
import { fileInRepo, parseWebviewMessage } from '../../src/extension/lib/webview-messages.ts';

describe('manifeste de l\'extension', () => {
    const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')) as Record<string, unknown>;

    it('même version que le projet (la release vérifie le tag contre package.json)', () => {
        expect(readJson('extension/package.json').version).toBe(readJson('package.json').version);
    });

    it('commandes et vues déclarées = commandes et vues enregistrées par extension.ts', () => {
        const manifest = readJson('extension/package.json') as { contributes: { commands: { command: string }[]; views: Record<string, { id: string }[]> } };
        const source = fs.readFileSync(new URL('../../src/extension/extension.ts', import.meta.url), 'utf8');
        const registered = (pattern: RegExp): string[] => [...source.matchAll(pattern)].map((m) => m[1] ?? '').sort();
        expect(registered(/registerCommand\('([^']+)'/g)).toEqual(manifest.contributes.commands.map((c) => c.command).sort());
        expect(registered(/registerTreeDataProvider\('([^']+)'/g)).toEqual(Object.values(manifest.contributes.views).flat().map((v) => v.id).sort());
    });
});

describe('HTML du panneau', () => {
    const index = '<!doctype html><html><head>\n<title>Revspan</title><script type="module" src="./assets/a.js"></script></head><body></body></html>';

    it('ajoute la politique de sécurité et la route initiale, réécrit les fichiers en adresses du panneau (sans <base>)', () => {
        const html = buildWebviewHtml(index, { assetsBaseUri: 'https://file.vscode-cdn.net/ext/dist/web/', cspSource: 'https://*.vscode-cdn.net', initialRoute: '/pr/ws/repo/42' });
        expect(html).toMatch(/<head>\n {4}<meta http-equiv="Content-Security-Policy"/);
        expect(html).toContain('<meta name="revspan-route" content="/pr/ws/repo/42">');
        expect(html).toContain('src="https://file.vscode-cdn.net/ext/dist/web/assets/a.js"');
        expect(html).not.toContain('<base');
    });

    it('échappe la route et refuse une page sans <head>', () => {
        const html = buildWebviewHtml(index, { assetsBaseUri: 'x', cspSource: 'y', initialRoute: '/"><script>' });
        expect(html).toContain('content="/&#34;&#62;&#60;script&#62;"');
        expect(() => buildWebviewHtml('<html></html>', { assetsBaseUri: 'x', cspSource: 'y', initialRoute: '/' })).toThrow('<head>');
    });

    it('politique stricte : aucun script en ligne, aucun accès réseau', () => {
        const csp = contentSecurityPolicy('https://*.vscode-cdn.net');
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain('script-src https://*.vscode-cdn.net');
        expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
        expect(csp).toContain("connect-src 'none'");
        expect(csp).toContain("base-uri 'none'");
    });
});

describe('messages de la page', () => {
    const ref = { workspace: 'acme', repo: 'records-api', id: 212 };

    it('messages bien formés acceptés ; seuls workspace, dépôt et numéro gardés dans la référence', () => {
        const read = { type: 'request', id: 3, method: 'GET', path: '/api/home' };
        const write = { type: 'request', id: 4, method: 'POST', path: '/api/pr/acme/records-api/212/comments', body: { raw: 'Merci' } };
        const openFile = { type: 'openFile', ref, path: 'src/A.ts', line: 7 };
        const openDiff = { type: 'openDiff', ref, from: 0, to: 3, path: 'src/A.ts', oldPath: 'src/Old.ts' };
        for (const message of [read, write, openFile, { ...openFile, line: null }, openDiff, { ...openDiff, oldPath: null }]) {
            expect(parseWebviewMessage(message)).toEqual(message);
        }
        expect(parseWebviewMessage({ ...openFile, ref: { ...ref, extra: 'x' } })).toEqual(openFile);
    });

    it('message mal formé : null, sans exception', () => {
        const openFile = { type: 'openFile', ref, path: 'src/A.ts', line: 7 };
        const openDiff = { type: 'openDiff', ref, from: 2, to: 3, path: 'src/A.ts', oldPath: null };
        const malformed: unknown[] = [
            null, undefined, 42, 'request', [], {}, { type: 'other' },
            { type: 'request', id: '1', method: 'GET', path: '/api/home' },
            { type: 'request', id: 1.5, method: 'GET', path: '/api/home' },
            { type: 'request', id: 1, method: 'GET' },
            { type: 'request', id: 1, method: 7, path: '/api/home' },
            { ...openFile, ref: null },
            { ...openFile, ref: { ...ref, workspace: '..' } },
            { ...openFile, ref: { ...ref, repo: 'records-api/../x' } },
            { ...openFile, ref: { ...ref, id: 0 } },
            { ...openFile, ref: { ...ref, id: 1.5 } },
            { ...openFile, path: '' },
            { ...openFile, path: 42 },
            { ...openFile, line: 0 },
            { ...openFile, line: 1.5 },
            { type: 'openFile', ref, path: 'src/A.ts' },
            { ...openDiff, from: -1 },
            { ...openDiff, from: '2' },
            { ...openDiff, to: 0 },
            { ...openDiff, to: 3.5 },
            { ...openDiff, oldPath: 3 },
        ];
        for (const data of malformed) {
            expect(parseWebviewMessage(data), JSON.stringify(data)).toBeNull();
        }
    });
});

describe('fichier du dépôt local', () => {
    it('chemin relatif dans le dépôt : chemin absolu du fichier', () => {
        expect(fileInRepo('/dev/records-api', 'src/A.ts')).toBe('/dev/records-api/src/A.ts');
        expect(fileInRepo('/dev/records-api/', 'src/../README.md')).toBe('/dev/records-api/README.md');
    });

    it('chemin absolu ou qui sort du dépôt : null', () => {
        for (const file of ['../../.ssh/id_rsa', 'src/../../x', '../records-api-copy/x', '/etc/passwd', '', '.', 'src/\0A.ts']) {
            expect(fileInRepo('/dev/records-api', file), file).toBeNull();
        }
    });
});

describe('dépôt local', () => {
    /** Système de fichiers simulé : chemins → contenu (null = dossier). */
    function fakeFs(entries: Record<string, string | null>): RepoFs {
        return {
            exists: (file) => file in entries,
            readText: (file) => entries[file] ?? null,
            listDirs: (dir) => [...new Set(Object.keys(entries)
                .filter((p) => p.startsWith(`${dir}/`))
                .map((p) => p.slice(dir.length + 1).split('/')[0] ?? '')
                .filter((name) => name && entries[path.join(dir, name)] === null))],
        };
    }

    // Copie principale dans /dev, worktree enregistré par git hors de l'espace de travail (/tmp/wt/demo).
    const fs = fakeFs({
        '/dev/records-api': null,
        '/dev/records-api/.git': null,
        '/dev/records-api/.git/HEAD': 'ref: refs/heads/main\n',
        '/dev/records-api/.git/worktrees': null,
        '/dev/records-api/.git/worktrees/demo': null,
        '/dev/records-api/.git/worktrees/demo/gitdir': '/tmp/wt/demo/.git\n',
        '/dev/records-api/.git/worktrees/demo/HEAD': 'ref: refs/heads/feature/demo\n',
        '/tmp/wt/demo': null,
        '/tmp/wt/demo/.git': 'gitdir: /dev/records-api/.git/worktrees/demo\n',
    });

    it('lit la branche extraite (copie principale et worktree)', () => {
        expect(currentBranch('/dev/records-api', fs)).toBe('main');
        expect(currentBranch('/tmp/wt/demo', fs)).toBe('feature/demo');
    });

    it('préfère un worktree enregistré par git sur la branche de la PR, où qu\'il soit', () => {
        expect(findLocalRepo(['/dev'], 'records-api', 'feature/demo', fs))
            .toEqual({ dir: '/tmp/wt/demo', branch: 'feature/demo', onPrBranch: true });
    });

    it('espace de travail ouvert sur le worktree lui-même : reconnu par sa copie principale', () => {
        expect(findLocalRepo(['/tmp/wt/demo'], 'records-api', 'feature/demo', fs)).toMatchObject({ dir: '/tmp/wt/demo', onPrBranch: true });
        expect(findLocalRepo(['/tmp/wt/demo'], 'records-api', 'feature/autre', fs)).toMatchObject({ dir: '/tmp/wt/demo', onPrBranch: false });
    });

    it('sinon la copie principale, signalée hors branche', () => {
        expect(findLocalRepo(['/dev'], 'records-api', 'feature/autre', fs)).toEqual({ dir: '/dev/records-api', branch: 'main', onPrBranch: false });
        expect(findLocalRepo(['/dev/records-api'], 'records-api', null, fs)).toMatchObject({ dir: '/dev/records-api' });
    });

    it('null si le dépôt n\'est pas dans l\'espace de travail', () => {
        expect(findLocalRepo(['/dev'], 'records-import', null, fs)).toBeNull();
    });
});

describe('documents de diff', () => {
    it('aller-retour, chemin terminé par le fichier (coloration), titre', () => {
        const doc = { ref: { workspace: 'acme', repo: 'records-api', id: 212 }, from: 9, to: 10, side: 'old' as const, path: 'src/A.ts', oldPath: 'src/Old.ts' };
        const encoded = encodeDiffDocument(doc);
        expect(encoded.path).toBe('/records-api/v9/src/Old.ts');
        expect(decodeDiffDocument(encoded.query)).toEqual(doc);
        expect(encodeDiffDocument({ ...doc, side: 'new', oldPath: null }).path).toBe('/records-api/v10/src/A.ts');
        expect(decodeDiffDocument('ws=a&repo=b')).toBeNull();
        expect(diffTitle('src/records/CreateRecord.ts', 9, 10)).toBe('CreateRecord.ts (v9 → v10)');
        expect(diffTitle('a.ts', 0, 3)).toBe('a.ts (base → v3)');
    });
});

describe('arbre « Mes PR »', () => {
    const card = (id: number, extra: Partial<PrCard> = {}): PrCard => ({
        workspace: 'acme', repo: 'records-api', id, title: `PR ${id}`, author: { uuid: '{a}', displayName: 'Camille' }, url: '',
        createdOn: '', updatedOn: '', versionsCount: 3, lastPushAt: '', lastReviewed: 1, newVersions: 2, newCodeVersions: 1,
        approvals: 1, myApproval: false, newComments: 2, ...extra,
    });

    it('groupes non vides, badges, « Autres » replié quand je suis connu', () => {
        const home: Home = {
            me: { uuid: '{me}', displayName: 'Moi' },
            repos: ['acme/records-api'],
            errors: [],
            groups: [
                { key: 'to-review', title: 'À relire', prs: [card(1)] },
                { key: 'up-to-date', title: 'À jour', prs: [] },
                { key: 'others', title: 'Autres PR ouvertes', prs: [card(2, { lastReviewed: null, versionsCount: null })] },
            ],
        };
        const tree = buildHomeTree(home);
        expect(tree.map((g) => [g.label, g.icon, g.collapsed])).toEqual([['À relire (1)', 'eye', false], ['Autres PR ouvertes (1)', 'git-pull-request', true]]);
        expect(tree[0]?.prs[0]).toMatchObject({ ref: { workspace: 'acme', repo: 'records-api', id: 1 }, label: 'records-api #1 · PR 1', description: '+2 versions · dont 1 avec du code · 💬 2' });
        expect(tree[1]?.prs[0]).toMatchObject({ label: 'records-api #2 · PR 2', description: 'pas encore relue · 💬 2' });
        expect(buildHomeTree({ ...home, me: null }).find((g) => g.key === 'others')?.collapsed).toBe(false);
    });
});
