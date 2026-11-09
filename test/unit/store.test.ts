import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store, type RepoSource } from '../../src/server/infra/config.ts';

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-store-'));
    dirs.push(dir);
    return dir;
};
const configFile = (dir: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;

/** In-memory repository source (like the VS Code revspan.repositories setting). */
function memorySource(initial: string[]): RepoSource & { value: string[] } {
    return {
        value: initial,
        get() {
            return this.value;
        },
        async set(repos) {
            this.value = repos;
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('local settings (Store)', () => {
    it('without an external source: repositories and e-mail in config.json', async () => {
        const dir = tempDir();
        const store = new Store(dir);
        expect(store.config).toEqual({ email: '', repos: [] });
        await store.saveConfig({ email: 'a@b.c', repos: ['ws/a'] });
        expect(configFile(dir)).toEqual({ email: 'a@b.c', repos: ['ws/a'] });
        expect(new Store(dir).config.repos).toEqual(['ws/a']);
    });

    it('with an external source: repositories read and written in the source, normalized, never in config.json', async () => {
        const dir = tempDir();
        const source = memorySource(['https://bitbucket.org/ws/a/src/main/', 'not a repo', 'ws/a', 'ws/b']);
        const store = new Store(dir, { repoSource: source });
        expect(store.config.repos).toEqual(['ws/a', 'ws/b']);

        const saved = await store.saveConfig({ email: 'a@b.c', repos: ['ws/c'] });
        expect(source.value).toEqual(['ws/c']);
        expect(saved).toEqual({ email: 'a@b.c', repos: ['ws/c'] });
        expect(configFile(dir)).toEqual({ email: 'a@b.c', repos: [] });

        source.value = ['ws/d'];
        expect(store.config.repos).toEqual(['ws/d']);
    });
});

describe('PR state write that fails', () => {
    it('leaves no phantom mark in memory: the state read next is the one on disk', () => {
        const dir = tempDir();
        const store = new Store(dir);
        const key = 'acme/records-api#1';
        store.updatePrState(key, (s) => {
            s.viewed['src/a.ts'] = 'h1';
            s.kinds['0123456789ab'] = 'code';
        });
        vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        });
        expect(() => store.updatePrState(key, (s) => {
            s.viewed['src/b.ts'] = 'h2';
            s.kinds['ba9876543210'] = 'rebase-only';
        })).toThrow(/ENOSPC/);
        expect(store.prState(key).viewed).toEqual({ 'src/a.ts': 'h1' });
        expect(store.prState(key).kinds).toEqual({ '0123456789ab': 'code' });
    });
});

describe('state shared between several windows (two Stores, same folder)', () => {
    it('two marks on different PRs are both kept and visible on both sides', () => {
        const dir = tempDir();
        const a = new Store(dir);
        const b = new Store(dir);
        a.updatePrState('acme/records-api#1', (s) => {
            s.reviewedAt = '2026-01-01T00:00:00Z';
        });
        b.updatePrState('acme/records-api#2', (s) => {
            s.viewed['src/a.ts'] = 'abc';
        });
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as { prs: Record<string, unknown> };
        expect(Object.keys(onDisk.prs).sort()).toEqual(['acme/records-api#1', 'acme/records-api#2']);
        expect(a.prState('acme/records-api#2').viewed).toEqual({ 'src/a.ts': 'abc' });
        expect(b.prState('acme/records-api#1').reviewedAt).toBe('2026-01-01T00:00:00Z');
    });

    it('a mark made by A after B was created is read by B', () => {
        const dir = tempDir();
        const a = new Store(dir);
        const b = new Store(dir);
        expect(b.prState('acme/records-api#1').viewed).toEqual({});
        a.updatePrState('acme/records-api#1', (s) => {
            s.viewed['x.ts'] = 'h1';
        });
        expect(b.prState('acme/records-api#1').viewed).toEqual({ 'x.ts': 'h1' });
    });

    it('config modified by A is visible to B, and B does not overwrite it when saving something else', async () => {
        const dir = tempDir();
        const a = new Store(dir);
        const b = new Store(dir);
        await a.saveConfig({ repos: ['acme/records-api'] });
        expect(b.config.repos).toEqual(['acme/records-api']);
        const c = new Store(dir);
        await a.saveConfig({ repos: ['acme/records-api', 'acme/billing'] });
        await c.saveConfig({ email: 'rev@example.com' });
        expect(configFile(dir)).toEqual({ email: 'rev@example.com', repos: ['acme/records-api', 'acme/billing'] });
    });

    it('deleted or corrupt file: default values', () => {
        const dir = tempDir();
        const a = new Store(dir);
        a.updatePrState('acme/records-api#1', (s) => {
            s.viewed['x.ts'] = 'h1';
        });
        fs.writeFileSync(path.join(dir, 'state.json'), '{pas du json');
        expect(a.prState('acme/records-api#1').viewed).toEqual({});
        fs.rmSync(path.join(dir, 'state.json'));
        expect(a.prState('acme/records-api#1').viewed).toEqual({});
    });
});
