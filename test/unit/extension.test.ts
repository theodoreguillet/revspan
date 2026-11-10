import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Home, PrCard } from '../../src/shared/api.ts';
import { buildWebviewHtml, contentSecurityPolicy } from '../../src/extension/lib/webview-html.ts';
import { bitbucketRepoOfRemote, currentBranch, findLocalRepo, type RepoFs } from '../../src/extension/lib/repo-path.ts';
import { decodeDiffDocument, diffTitle, encodeDiffDocument } from '../../src/extension/lib/diff-uri.ts';
import { buildHomeTree, repoErrorLabel } from '../../src/extension/lib/home-tree.ts';
import { createL10n, pageLocale, type L10n, type Translate } from '../../src/extension/lib/l10n.ts';
import { errorText as extensionErrorText } from '../../src/extension/lib/error-text.ts';
import type { ErrorLike } from '../../src/shared/error-text.ts';
import { createTranslator } from '../../src/web/i18n/translator.ts';
import { errorText as pageErrorText } from '../../src/web/lib/errors.ts';
import { fileInRepo, parseWebviewMessage } from '../../src/extension/lib/webview-messages.ts';
import { settingTarget } from '../../src/extension/lib/setting-target.ts';
import { PANEL_VIEW_TYPE, panelTitle, restoredRoute, routeOfApiRead } from '../../src/extension/lib/panel-route.ts';

const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')) as Record<string, unknown>;

/** vscode.l10n.t's formatting: `{name}` placeholders filled from the arguments, unknown ones left as is. */
const format = (message: string, args: Record<string, string | number> = {}): string =>
    message.replace(/\{(\w+)\}/g, (match, name: string) => (name in args ? String(args[name]) : match));
const frenchBundle = readJson('extension/l10n/bundle.l10n.fr.json') as Record<string, string>;
/** vscode.l10n.t with VS Code in English (no bundle) and in French (the extension's bundle). */
const enT: Translate = (message, args) => format(message, args);
const frT: Translate = (message, args) => format(frenchBundle[message] ?? message, args);
const en: L10n = createL10n(enT, 'en');
const fr: L10n = createL10n(frT, 'fr');

describe('extension manifest', () => {
    it('same version as the project (the release checks the tag against package.json)', () => {
        expect(readJson('extension/package.json').version).toBe(readJson('package.json').version);
    });

    it('declared commands and views = commands and views registered by extension.ts', () => {
        const manifest = readJson('extension/package.json') as { contributes: { commands: { command: string }[]; views: Record<string, { id: string }[]> } };
        const source = fs.readFileSync(new URL('../../src/extension/extension.ts', import.meta.url), 'utf8');
        const registered = (pattern: RegExp): string[] => [...source.matchAll(pattern)].map((m) => m[1] ?? '').sort();
        expect(registered(/registerCommand\('([^']+)'/g)).toEqual(manifest.contributes.commands.map((c) => c.command).sort());
        expect(registered(/registerTreeDataProvider\('([^']+)'/g)).toEqual(Object.values(manifest.contributes.views).flat().map((v) => v.id).sort());
    });

    it('panel reopened after "Reload Window": activation event and serializer of the same type', () => {
        const manifest = readJson('extension/package.json') as { activationEvents?: string[] };
        expect(manifest.activationEvents).toContain(`onWebviewPanel:${PANEL_VIEW_TYPE}`);
        const source = (file: string): string => fs.readFileSync(new URL(`../../src/extension/${file}`, import.meta.url), 'utf8');
        expect(source('extension.ts')).toContain('registerWebviewPanelSerializer(PANEL_VIEW_TYPE,');
        expect(source('panel.ts')).toContain('createWebviewPanel(PANEL_VIEW_TYPE,');
    });

    it('an untrusted workspace cannot impose its repositories, approvals per repository or followed contributors', () => {
        const manifest = readJson('extension/package.json') as {
            capabilities: { untrustedWorkspaces: Record<string, unknown> };
            contributes: { configuration: { properties: Record<string, unknown> } };
        };
        // VS Code only applies restrictedConfigurations with supported: 'limited'.
        expect(manifest.capabilities.untrustedWorkspaces).toMatchObject({
            supported: 'limited',
            restrictedConfigurations: ['revspan.repositories', 'revspan.review.requiredApprovalsByRepository', 'revspan.review.followedContributors'],
        });
        for (const id of ['revspan.repositories', 'revspan.review.requiredApprovalsByRepository', 'revspan.review.followedContributors']) {
            expect(manifest.contributes.configuration.properties).toHaveProperty([id]);
        }
    });
});

describe('tracked repositories setting', () => {
    it('writes where the effective value is defined: workspace if it defines it, otherwise user', () => {
        expect(settingTarget({ workspaceValue: ['acme/records-api'], globalValue: ['acme/records-import'] }, true)).toBe('workspace');
        expect(settingTarget({ workspaceValue: [] }, true)).toBe('workspace');
        expect(settingTarget({ globalValue: ['acme/records-import'] }, true)).toBe('global');
        expect(settingTarget(undefined, true)).toBe('global');
    });

    it('untrusted workspace: VS Code ignores its value, we write at the user level', () => {
        expect(settingTarget({ workspaceValue: ['acme/records-api'] }, false)).toBe('global');
    });
});

describe('panel HTML', () => {
    const index = '<!doctype html><html><head>\n<title>Revspan</title><script type="module" src="./assets/a.js"></script></head><body></body></html>';

    it('adds the security policy and the initial route, rewrites the files to panel addresses (no <base>)', () => {
        const html = buildWebviewHtml(index, { assetsBaseUri: 'https://file.vscode-cdn.net/ext/dist/web/', cspSource: 'https://*.vscode-cdn.net', initialRoute: '/pr/ws/repo/42', locale: 'fr' });
        expect(html).toMatch(/<head>\n {4}<meta http-equiv="Content-Security-Policy"/);
        expect(html).toContain('<meta name="revspan-route" content="/pr/ws/repo/42">');
        expect(html).toContain('<meta name="revspan-locale" content="fr">');
        expect(html).toContain('src="https://file.vscode-cdn.net/ext/dist/web/assets/a.js"');
        expect(html).not.toContain('<base');
    });

    it('escapes the route and rejects a page without <head>', () => {
        const html = buildWebviewHtml(index, { assetsBaseUri: 'x', cspSource: 'y', initialRoute: '/"><script>', locale: 'en' });
        expect(html).toContain('content="/&#34;&#62;&#60;script&#62;"');
        expect(() => buildWebviewHtml('<html></html>', { assetsBaseUri: 'x', cspSource: 'y', initialRoute: '/', locale: 'en' })).toThrow('<head>');
    });

    it('strict policy: no inline script, no network access', () => {
        const csp = contentSecurityPolicy('https://*.vscode-cdn.net');
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain('script-src https://*.vscode-cdn.net');
        expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
        expect(csp).toContain("connect-src 'none'");
        expect(csp).toContain("base-uri 'none'");
    });
});

describe('panel title', () => {
    it('from the displayed route', () => {
        expect(panelTitle(enT, '/pr/acme/records-api/212?from=2&to=6')).toBe('PR #212 · records-api');
        expect(panelTitle(enT, '/')).toBe('Revspan');
        expect(panelTitle(enT, '/settings')).toBe('Revspan · Settings');
        expect(panelTitle(frT, '/settings')).toBe('Revspan · Réglages');
    });

    it('page API read: route of the screen that makes it (home, settings, PR), otherwise null', () => {
        expect(routeOfApiRead('GET', '/api/home')).toBe('/');
        expect(routeOfApiRead('GET', '/api/home?fresh=1')).toBe('/');
        expect(routeOfApiRead('GET', '/api/settings')).toBe('/settings');
        expect(routeOfApiRead('GET', '/api/pr/acme/records-api/212')).toBe('/pr/acme/records-api/212');
        expect(routeOfApiRead('GET', '/api/pr/acme/records-api/212/compare?from=2&to=6&context=3')).toBe('/pr/acme/records-api/212');
        expect(routeOfApiRead('PUT', '/api/settings')).toBeNull();
        expect(routeOfApiRead('POST', '/api/pr/acme/records-api/212/approve')).toBeNull();
        expect(routeOfApiRead('GET', '/api/health')).toBeNull();
        expect(routeOfApiRead('GET', '/api/homepage')).toBeNull();
    });
});

describe('restored panel', () => {
    it('route saved by the page; home if the state is missing or invalid', () => {
        expect(restoredRoute({ route: '/pr/acme/records-api/212?from=2&to=6' })).toBe('/pr/acme/records-api/212?from=2&to=6');
        expect(restoredRoute({ route: '/settings' })).toBe('/settings');
        const invalid: unknown[] = [undefined, null, 'x', 42, {}, { route: 42 }, { route: '' }, { route: 'settings' }, { route: '//evil.example/x' }, { route: 'https://evil.example/' }];
        for (const state of invalid) {
            expect(restoredRoute(state), JSON.stringify(state)).toBe('/');
        }
    });
});

describe('page messages', () => {
    const ref = { workspace: 'acme', repo: 'records-api', id: 212 };

    it('well-formed messages accepted; only workspace, repo and number kept in the reference', () => {
        const read = { type: 'request', id: 3, method: 'GET', path: '/api/home' };
        const write = { type: 'request', id: 4, method: 'POST', path: '/api/pr/acme/records-api/212/comments', body: { raw: 'Merci' } };
        const openFile = { type: 'openFile', ref, path: 'src/A.ts', line: 7 };
        const openDiff = { type: 'openDiff', ref, from: 0, to: 3, path: 'src/A.ts', oldPath: 'src/Old.ts' };
        for (const message of [read, write, openFile, { ...openFile, line: null }, openDiff, { ...openDiff, oldPath: null }]) {
            expect(parseWebviewMessage(message)).toEqual(message);
        }
        expect(parseWebviewMessage({ ...openFile, ref: { ...ref, extra: 'x' } })).toEqual(openFile);
    });

    it('malformed message: null, no exception', () => {
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

describe('local repository file', () => {
    it('relative path in the repository: absolute path of the file', () => {
        expect(fileInRepo('/dev/records-api', 'src/A.ts')).toBe('/dev/records-api/src/A.ts');
        expect(fileInRepo('/dev/records-api/', 'src/../README.md')).toBe('/dev/records-api/README.md');
    });

    it('absolute path or one leaving the repository: null', () => {
        for (const file of ['../../.ssh/id_rsa', 'src/../../x', '../records-api-copy/x', '/etc/passwd', '', '.', 'src/\0A.ts']) {
            expect(fileInRepo('/dev/records-api', file), file).toBeNull();
        }
    });
});

describe('local repository', () => {
    /** Simulated file system: paths -> content (null = folder). */
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

    // Main copy in /dev, worktree registered by git outside the workspace (/tmp/wt/demo).
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

    it('reads the checked-out branch (main copy and worktree)', () => {
        expect(currentBranch('/dev/records-api', fs)).toBe('main');
        expect(currentBranch('/tmp/wt/demo', fs)).toBe('feature/demo');
    });

    const target = { workspace: 'acme', repo: 'records-api' };

    it('prefers a worktree registered by git on the PR\'s branch, wherever it is', () => {
        expect(findLocalRepo(['/dev'], target, 'feature/demo', fs))
            .toEqual({ dir: '/tmp/wt/demo', branch: 'feature/demo', onPrBranch: true });
    });

    it('workspace opened on the worktree itself: recognized through its main copy', () => {
        expect(findLocalRepo(['/tmp/wt/demo'], target, 'feature/demo', fs)).toMatchObject({ dir: '/tmp/wt/demo', onPrBranch: true });
        expect(findLocalRepo(['/tmp/wt/demo'], target, 'feature/autre', fs)).toMatchObject({ dir: '/tmp/wt/demo', onPrBranch: false });
    });

    it('otherwise the main copy, flagged as off-branch', () => {
        expect(findLocalRepo(['/dev'], target, 'feature/autre', fs)).toEqual({ dir: '/dev/records-api', branch: 'main', onPrBranch: false });
        expect(findLocalRepo(['/dev/records-api'], target, null, fs)).toMatchObject({ dir: '/dev/records-api' });
    });

    it('null if the repository is not in the workspace', () => {
        expect(findLocalRepo(['/dev'], { workspace: 'acme', repo: 'records-import' }, null, fs)).toBeNull();
    });

    /** Git copy (.git folder) with its branch and remotes. */
    const clone = (dir: string, branch: string, urls: string[]): Record<string, string | null> => ({
        [dir]: null,
        [`${dir}/.git`]: null,
        [`${dir}/.git/HEAD`]: `ref: refs/heads/${branch}\n`,
        [`${dir}/.git/config`]: ['[core]', '\tbare = false', ...urls.flatMap((url, i) => [`[remote "r${i}"]`, `\turl = ${url}`, `\tfetch = +refs/heads/*:refs/remotes/r${i}/*`])].join('\n'),
    });

    it('Bitbucket remote URL: https (with or without user), ssh, scp; .git optional', () => {
        const repo = { workspace: 'acme', repo: 'records-api' };
        for (const url of [
            'https://bitbucket.org/acme/records-api.git', 'https://camille@bitbucket.org/acme/records-api', 'git@bitbucket.org:acme/records-api.git',
            'ssh://git@bitbucket.org/acme/records-api.git', 'https://bitbucket.org/acme/records-api/', ' git@bitbucket.org:acme/records-api ',
        ]) {
            expect(bitbucketRepoOfRemote(url), url).toEqual(repo);
        }
        for (const url of ['https://github.com/acme/records-api.git', 'https://bitbucket.org.evil.example/acme/records-api', 'git@bitbucket.org:acme/records-api/x.git', 'https://bitbucket.org/acme', '/srv/git/records-api.git']) {
            expect(bitbucketRepoOfRemote(url), url).toBeNull();
        }
    });

    it('renamed copy recognized by one of its remotes', () => {
        const renamed = fakeFs({
            '/dev': null,
            ...clone('/dev/api', 'main', ['https://github.com/camille/mirror.git', 'git@bitbucket.org:acme/records-api.git']),
            ...clone('/dev/other', 'main', ['git@bitbucket.org:acme/records-import.git']),
        });
        expect(findLocalRepo(['/dev'], target, null, renamed)).toEqual({ dir: '/dev/api', branch: 'main', onPrBranch: false });
        expect(findLocalRepo(['/dev'], { workspace: 'ACME', repo: 'Records-API' }, null, renamed)).toMatchObject({ dir: '/dev/api' });
    });

    it('same-named repositories in different workspaces: the exact <workspace>/<repo> remote wins over the folder name', () => {
        const homonyms = fakeFs({
            '/work-a': null,
            '/work-b': null,
            ...clone('/work-a/records-api', 'feature/demo', ['https://bitbucket.org/other/records-api.git']),
            ...clone('/work-b/records-api', 'main', ['https://bitbucket.org/acme/records-api.git']),
        });
        expect(findLocalRepo(['/work-a', '/work-b'], target, 'feature/demo', homonyms)).toMatchObject({ dir: '/work-b/records-api', onPrBranch: false });
        expect(findLocalRepo(['/work-a', '/work-b'], { workspace: 'other', repo: 'records-api' }, null, homonyms)).toMatchObject({ dir: '/work-a/records-api' });
        // No matching remote: fall back to the folder name.
        expect(findLocalRepo(['/work-a', '/work-b'], { workspace: 'fork', repo: 'records-api' }, null, homonyms)).toMatchObject({ dir: '/work-a/records-api' });
    });

    // Bare repository and its worktrees (git clone --bare + git worktree add): commondir leads to the common repository.
    const bare = (config: string): Record<string, string | null> => ({
        '/dev/records-api.git': null,
        '/dev/records-api.git/HEAD': 'ref: refs/heads/main\n',
        '/dev/records-api.git/config': config,
        '/dev/records-api.git/worktrees': null,
        '/dev/records-api.git/worktrees/main': null,
        '/dev/records-api.git/worktrees/main/gitdir': '/dev/wt/main/.git\n',
        '/dev/records-api.git/worktrees/main/commondir': '../..\n',
        '/dev/records-api.git/worktrees/main/HEAD': 'ref: refs/heads/main\n',
        '/dev/records-api.git/worktrees/demo': null,
        '/dev/records-api.git/worktrees/demo/gitdir': '/tmp/demo/.git\n',
        '/dev/records-api.git/worktrees/demo/commondir': '../..\n',
        '/dev/records-api.git/worktrees/demo/HEAD': 'ref: refs/heads/feature/demo\n',
        '/dev/wt': null,
        '/dev/wt/main': null,
        '/dev/wt/main/.git': 'gitdir: /dev/records-api.git/worktrees/main\n',
        '/tmp/demo': null,
        '/tmp/demo/.git': 'gitdir: /dev/records-api.git/worktrees/demo\n',
    });

    it('worktree of a bare repository: traced back to the common repository and its other worktrees (remote or bare repository name)', () => {
        const withRemote = fakeFs(bare('[core]\n\tbare = true\n[remote "origin"]\n\turl = git@bitbucket.org:acme/records-api.git\n'));
        expect(findLocalRepo(['/dev/wt/main'], target, 'feature/demo', withRemote)).toEqual({ dir: '/tmp/demo', branch: 'feature/demo', onPrBranch: true });
        expect(findLocalRepo(['/dev/wt/main'], target, 'feature/autre', withRemote)).toMatchObject({ dir: '/dev/wt/main', onPrBranch: false });
        const withoutRemote = fakeFs(bare('[core]\n\tbare = true\n'));
        expect(findLocalRepo(['/dev/wt/main'], target, 'feature/demo', withoutRemote)).toMatchObject({ dir: '/tmp/demo', onPrBranch: true });
    });

    it('folder pointing to a bare repository (.bare): its worktrees, never the folder itself', () => {
        const container = fakeFs({
            '/src': null,
            '/src/records-api': null,
            '/src/records-api/.git': 'gitdir: ./.bare\n',
            '/src/records-api/.bare': null,
            '/src/records-api/.bare/HEAD': 'ref: refs/heads/main\n',
            '/src/records-api/.bare/config': '[core]\n\tbare = true\n[remote "origin"]\n\turl = https://bitbucket.org/acme/records-api.git\n',
            '/src/records-api/.bare/worktrees': null,
            '/src/records-api/.bare/worktrees/main': null,
            '/src/records-api/.bare/worktrees/main/gitdir': '/src/records-api/main/.git\n',
            '/src/records-api/.bare/worktrees/main/commondir': '../..\n',
            '/src/records-api/.bare/worktrees/main/HEAD': 'ref: refs/heads/main\n',
            '/src/records-api/main': null,
            '/src/records-api/main/.git': 'gitdir: /src/records-api/.bare/worktrees/main\n',
        });
        expect(findLocalRepo(['/src'], target, 'feature/autre', container)).toEqual({ dir: '/src/records-api/main', branch: 'main', onPrBranch: false });
    });
});

describe('diff documents', () => {
    it('round trip, path ending with the file (highlighting), title', () => {
        const doc = { ref: { workspace: 'acme', repo: 'records-api', id: 212 }, from: 9, to: 10, side: 'old' as const, path: 'src/A.ts', oldPath: 'src/Old.ts' };
        const encoded = encodeDiffDocument(doc);
        expect(encoded.path).toBe('/records-api/v9/src/Old.ts');
        expect(decodeDiffDocument(encoded.query)).toEqual(doc);
        expect(encodeDiffDocument({ ...doc, side: 'new', oldPath: null }).path).toBe('/records-api/v10/src/A.ts');
        expect(decodeDiffDocument('ws=a&repo=b')).toBeNull();
        expect(diffTitle('src/records/CreateRecord.ts', 9, 10)).toBe('CreateRecord.ts (v9 → v10)');
        expect(diffTitle('a.ts', 0, 3)).toBe('a.ts (base → v3)');
    });

    it('missing, empty or invalid number, invalid PR reference: null (never 0 by default)', () => {
        const { query } = encodeDiffDocument({ ref: { workspace: 'acme', repo: 'records-api', id: 212 }, from: 0, to: 3, side: 'new', path: 'src/A.ts', oldPath: null });
        expect(decodeDiffDocument(query)).toMatchObject({ from: 0, to: 3 });
        const variants: [string, string | null][] = [
            ['id', null], ['from', null], ['to', null], ['id', ''], ['from', ''], ['id', '0'], ['from', '-1'], ['to', '0'],
            ['to', '1.5'], ['from', ' 2'], ['id', '1e3'], ['to', '0x10'], ['ws', '..'], ['repo', 'records-api/x'],
        ];
        for (const [key, value] of variants) {
            const params = new URLSearchParams(query);
            if (value === null) {
                params.delete(key);
            } else {
                params.set(key, value);
            }
            expect(decodeDiffDocument(params.toString()), `${key}=${value}`).toBeNull();
        }
    });
});

describe('"My PRs" tree', () => {
    const card = (id: number, extra: Partial<PrCard> = {}): PrCard => ({
        workspace: 'acme', repo: 'records-api', id, title: `PR ${id}`, author: { uuid: '{a}', displayName: 'Camille' }, url: '',
        createdOn: '', updatedOn: '', versionsCount: 3, lastPushAt: '', lastReviewed: 1, newVersions: 2, newCodeVersions: 1,
        approvals: 1, requiredApprovals: 2, myApproval: false, newComments: 2, needsReview: true, designatedReviewer: false,
        followed: false, approvalHolds: false, build: null, needsRebase: null, ...extra,
    });
    const home: Home = {
        me: { uuid: '{me}', displayName: 'Moi' },
        repos: ['acme/records-api'],
        errors: [],
        groups: [
            { key: 'to-do', prs: [card(1)] },
            { key: 'waiting', prs: [] },
            { key: 'others', prs: [card(2, { lastReviewed: null, versionsCount: null })] },
        ],
    };

    it('non-empty groups, badges, "Other" collapsed when I am known', () => {
        const tree = buildHomeTree(home, fr);
        expect(tree.map((g) => [g.label, g.icon, g.collapsed])).toEqual([['À faire (1)', 'eye', false], ['Autres PR ouvertes (1)', 'git-pull-request', true]]);
        expect(tree[0]?.prs[0]).toMatchObject({ ref: { workspace: 'acme', repo: 'records-api', id: 1 }, label: 'records-api #1 · PR 1', description: '+2 versions · dont 1 avec du code · 💬 2' });
        expect(tree[1]?.prs[0]).toMatchObject({ label: 'records-api #2 · PR 2', description: 'pas encore relue · 💬 2' });
        expect(buildHomeTree({ ...home, me: null }, fr).find((g) => g.key === 'others')?.collapsed).toBe(false);
    });

    it('in English: group titles from the key, badges and tooltip', () => {
        const tree = buildHomeTree(home, en);
        expect(tree.map((g) => g.label)).toEqual(['To do (1)', 'Other open PRs (1)']);
        expect(tree[0]?.prs[0]).toMatchObject({ description: '+2 versions · 1 with code · 💬 2' });
        expect(tree[0]?.prs[0]?.tooltip).toBe('PR 1\nacme/records-api #1 · Camille\n3 versions\n1 approval\n+2 versions\n1 with code\n💬 2');
        expect(tree[1]?.prs[0]).toMatchObject({ description: 'not reviewed yet · 💬 2' });
        const approved = buildHomeTree({ ...home, groups: [{ key: 'mine', prs: [card(3, { myApproval: true, approvals: 2, newVersions: 1 })] }] }, en);
        expect(approved.map((g) => g.label)).toEqual(['My PRs (1)']);
        expect(approved[0]?.prs[0]?.description).toBe('💬 2 · ✓ approved');
        expect(approved[0]?.prs[0]?.tooltip).toContain('2 approvals');
    });

    it('plurals follow the display language: 0 and 1 are singular in French, only 1 in English', () => {
        const zero = { ...home, groups: [{ key: 'others' as const, prs: [card(4, { versionsCount: 0, approvals: 0 })] }] };
        expect(buildHomeTree(zero, fr)[0]?.prs[0]?.tooltip).toContain('\n0 version\n');
        expect(buildHomeTree(zero, en)[0]?.prs[0]?.tooltip).toContain('\n0 versions\n');
        const one = { ...home, groups: [{ key: 'to-do' as const, prs: [card(5, { newVersions: 1, versionsCount: 1 })] }] };
        expect(buildHomeTree(one, en)[0]?.prs[0]?.description).toMatch(/^\+1 version · /);
        expect(buildHomeTree(one, fr)[0]?.prs[0]?.description).toMatch(/^\+1 version · /);
    });

    it('repository errors translated from their code and parameters', () => {
        const error = { repo: 'acme/no-such-repo', code: 'BB_NOT_FOUND' as const, message: 'Not found on Bitbucket: /repositories/acme/no-such-repo', params: { path: '/repositories/acme/no-such-repo' } };
        expect(repoErrorLabel(enT, error)).toBe('acme/no-such-repo: Not found on Bitbucket: /repositories/acme/no-such-repo');
        expect(repoErrorLabel(frT, error)).toBe('acme/no-such-repo : Introuvable sur Bitbucket : /repositories/acme/no-such-repo');
        expect(repoErrorLabel(frT, { repo: 'acme/x', code: 'BB_ERROR', message: 'Bitbucket redirect refused on /x' })).toBe('acme/x : Bitbucket redirect refused on /x');
    });
});

describe('VS Code display language', () => {
    it('page language: French for fr*, English otherwise', () => {
        for (const language of ['fr', 'fr-ca', 'FR', 'fr_FR']) {
            expect(pageLocale(language), language).toBe('fr');
        }
        for (const language of ['en', 'en-us', 'de', 'fy', 'qps-ploc', '']) {
            expect(pageLocale(language), language).toBe('en');
        }
    });

    it('plural rules of the language the texts are shown in (English rules for an untranslated language)', () => {
        expect([0, 1, 2].map((n) => createL10n(enT, 'fr-ca').isSingular(n))).toEqual([true, true, false]);
        expect([0, 1, 2].map((n) => createL10n(enT, 'en').isSingular(n))).toEqual([false, true, false]);
        expect([0, 1, 2].map((n) => createL10n(enT, 'ja').isSingular(n))).toEqual([false, true, false]);
    });
});

describe('error messages of the extension', () => {
    // Every message the shared choice can make (src/shared/error-text.ts), plus fallbacks to the server's message.
    const errors: ErrorLike[] = [
        { code: 'NO_TOKEN', message: 'x' },
        { code: 'BB_UNAUTHORIZED', message: 'x' },
        { code: 'BB_FORBIDDEN', message: 'x' },
        { code: 'BB_FORBIDDEN', message: 'x', params: { detail: 'Your credentials lack one or more required privilege scopes.' } },
        { code: 'BB_FORBIDDEN', message: 'x', params: { reason: 'profile-unreadable' } },
        { code: 'BB_NOT_FOUND', message: 'x', params: { path: '/repositories/acme/x' } },
        { code: 'BB_NOT_FOUND', message: 'x', params: { reason: 'no-versions' } },
        { code: 'BB_UNREACHABLE', message: 'x', params: { detail: 'fetch failed' } },
        { code: 'BB_ERROR', message: 'x', params: { status: 500, path: '/p' } },
        { code: 'BB_ERROR', message: 'x', params: { status: 500, path: '/p', detail: 'Something broke' } },
        { code: 'VERSION_UNAVAILABLE', message: 'x', params: { version: 3 } },
        { code: 'BAD_REQUEST', message: 'x', params: { reason: 'invalid-email' } },
        { code: 'BAD_REQUEST', message: 'x', params: { reason: 'email-required' } },
        { code: 'FORBIDDEN', message: 'x' },
        { code: 'INTERNAL', message: 'x', params: { detail: 'boom' } },
        { code: 'BAD_REQUEST', message: 'Invalid comparison: from 3 to 2.' },
        { code: 'BB_ERROR', message: 'Bitbucket redirect refused on /x' },
        { code: 'NOT_FOUND', message: 'Unknown route: GET /api/x' },
    ];

    it('same text as the page, in English and in French', () => {
        for (const error of errors) {
            expect(extensionErrorText(enT, error), JSON.stringify(error)).toBe(pageErrorText(createTranslator('en'), error));
            expect(extensionErrorText(frT, error), JSON.stringify(error)).toBe(pageErrorText(createTranslator('fr'), error));
        }
    });

    it('errors that only the page can see keep the raw message', () => {
        expect(extensionErrorText(frT, { code: 'NETWORK', message: 'Raw' })).toBe('Raw');
        expect(extensionErrorText(frT, { code: 'HTTP_502', message: 'Raw' })).toBe('Raw');
    });
});

describe('extension localization files', () => {
    const manifestText = fs.readFileSync(new URL('../../extension/package.json', import.meta.url), 'utf8');
    const nls = readJson('extension/package.nls.json') as Record<string, string>;
    const nlsFr = readJson('extension/package.nls.fr.json') as Record<string, string>;
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

    it('package.nls.json (English) and package.nls.fr.json have the same keys, none empty', () => {
        expect(Object.keys(nlsFr).sort()).toEqual(Object.keys(nls).sort());
        for (const [key, value] of [...Object.entries(nls), ...Object.entries(nlsFr)]) {
            expect(value.trim(), key).not.toBe('');
        }
    });

    it('every %key% of the manifest is defined, every key is used, and no French text is left in the manifest', () => {
        const used = [...manifestText.matchAll(/"%([\w.-]+)%"/g)].map((m) => m[1] ?? '');
        expect(used.length).toBeGreaterThan(10);
        expect([...new Set(used)].sort()).toEqual(Object.keys(nls).sort());
        expect(manifestText).not.toMatch(/[àâçéèêëîïôûùüœ«»]/i);
        const manifest = JSON.parse(manifestText) as { displayName: string; description: string; l10n?: string };
        expect(manifest.displayName).toBe('%displayName%');
        expect(manifest.description).toBe('%description%');
    });

    it('the l10n folder of the manifest holds the French bundle', () => {
        const manifest = JSON.parse(manifestText) as { l10n?: string };
        expect(manifest.l10n).toBe('./l10n');
        expect(fs.existsSync(new URL('../../extension/l10n/bundle.l10n.fr.json', import.meta.url))).toBe(true);
    });

    /** English messages passed to vscode.l10n.t (or to the `t` the host gives to lib/) in src/extension. */
    function messagesInCode(): Set<string> {
        const dir = new URL('../../src/extension/', import.meta.url);
        const files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts'));
        const messages = new Set<string>();
        for (const file of files) {
            const source = fs.readFileSync(new URL(file, dir), 'utf8');
            for (const match of source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
                messages.add((match[1] ?? '').replace(/\\(.)/g, '$1'));
            }
        }
        return messages;
    }

    it('every message of the code is translated in the French bundle, with the same placeholders, and nothing else is', () => {
        const messages = messagesInCode();
        expect(messages.size).toBeGreaterThan(20);
        expect(Object.keys(frenchBundle).sort()).toEqual([...messages].sort());
        for (const [message, french] of Object.entries(frenchBundle)) {
            expect(french.trim(), message).not.toBe('');
            expect(placeholders(french), message).toEqual(placeholders(message));
        }
    });

    it('placeholders of the manifest texts are kept in French', () => {
        for (const [key, value] of Object.entries(nls)) {
            expect(placeholders(nlsFr[key] ?? ''), key).toEqual(placeholders(value));
        }
    });
});
