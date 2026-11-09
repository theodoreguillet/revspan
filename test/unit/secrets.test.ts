import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSecretStore } from '../../src/server/infra/secrets.ts';

describe('token storage', () => {
    it('file: write with mode 0600, read, delete', async () => {
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

    // Opt-in: creates then deletes a temporary entry in the macOS keychain.
    it.runIf(process.platform === 'darwin' && process.env.REVSPAN_KEYCHAIN_TEST === '1')(
        'macOS keychain: long token passed through stdin, update, delete',
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
                await expect(store.set(account, 'bad"token')).rejects.toThrow('Invalid token');
            } finally {
                await store.remove(account);
            }
            expect(await store.get(account)).toBeNull();
        },
    );
});
