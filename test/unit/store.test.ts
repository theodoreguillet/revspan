import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, type RepoSource } from '../../src/server/infra/config.ts';

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-store-'));
    dirs.push(dir);
    return dir;
};
const configFile = (dir: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;

/** Source de dépôts en mémoire (comme le réglage VS Code revspan.repositories). */
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

describe('état partagé entre plusieurs fenêtres (deux Store, même dossier)', () => {
    it('deux marques sur des PR différentes sont toutes les deux conservées et visibles des deux côtés', () => {
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

    it('une marque faite par A après la création de B est lue par B', () => {
        const dir = tempDir();
        const a = new Store(dir);
        const b = new Store(dir);
        expect(b.prState('acme/records-api#1').viewed).toEqual({});
        a.updatePrState('acme/records-api#1', (s) => {
            s.viewed['x.ts'] = 'h1';
        });
        expect(b.prState('acme/records-api#1').viewed).toEqual({ 'x.ts': 'h1' });
    });

    it('la config modifiée par A est visible par B, et B ne l\'écrase pas en enregistrant autre chose', async () => {
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

    it('fichier supprimé ou corrompu : valeurs par défaut', () => {
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
