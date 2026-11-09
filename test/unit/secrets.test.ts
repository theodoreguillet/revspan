import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSecretStore } from '../../src/server/infra/secrets.ts';

describe('stockage du jeton', () => {
    it('fichier : écriture 0600, lecture, suppression', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-secrets-'));
        try {
            const store = await createSecretStore({ dir, env: { REVSPAN_TOKEN_STORE: 'file' } });
            expect(store.kind).toBe('file');
            expect(await store.get('a@b.c')).toBeNull();
            await store.set('a@b.c', 'tok-1');
            expect(await store.get('a@b.c')).toBe('tok-1');
            expect(fs.statSync(path.join(dir, 'token.json')).mode & 0o777).toBe(0o600);
            await store.remove('a@b.c');
            expect(await store.get('a@b.c')).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    // Opt-in : crée puis supprime une entrée temporaire dans le trousseau macOS.
    it.runIf(process.platform === 'darwin' && process.env.REVSPAN_KEYCHAIN_TEST === '1')(
        'trousseau macOS : jeton long passé par stdin, mise à jour, suppression',
        async () => {
            const service = `revspan-test-${process.pid}-${Date.now()}`;
            const store = await createSecretStore({ dir: os.tmpdir(), env: { REVSPAN_KEYCHAIN_SERVICE: service } });
            expect(store.kind).toBe('keychain');
            const account = 'test@revspan.local';
            try {
                const token = `ATATT3x-${'A'.repeat(150)}=_-.123`;
                await store.set(account, token);
                expect(await store.get(account)).toBe(token);
                await store.set(account, 'second-token');
                expect(await store.get(account)).toBe('second-token');
                await expect(store.set(account, 'bad"token')).rejects.toThrow('invalide');
            } finally {
                await store.remove(account);
            }
            expect(await store.get(account)).toBeNull();
        },
    );
});
