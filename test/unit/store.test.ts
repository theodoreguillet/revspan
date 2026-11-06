import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, type RepoSource } from '../../src/server/infra/config.ts';

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-store-'));
    dirs.push(dir);
    return dir;
};
const configFile = (dir: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;

/** Source de dépôts en mémoire (comme le réglage VS Code strata.repositories). */
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
    dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('réglages locaux (Store)', () => {
    it('sans source externe : dépôts et e-mail dans config.json', async () => {
        const dir = tempDir();
        const store = new Store(dir);
        expect(store.config).toEqual({ email: '', repos: [] });
        await store.saveConfig({ email: 'a@b.c', repos: ['ws/a'] });
        expect(configFile(dir)).toEqual({ email: 'a@b.c', repos: ['ws/a'] });
        expect(new Store(dir).config.repos).toEqual(['ws/a']);
    });

    it('avec une source externe : dépôts lus et écrits dans la source, normalisés, jamais dans config.json', async () => {
        const dir = tempDir();
        const source = memorySource(['https://bitbucket.org/ws/a/src/main/', 'pas un dépôt', 'ws/a', 'ws/b']);
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
