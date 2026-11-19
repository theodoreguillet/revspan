import { describe, expect, it } from 'vitest';
import { newSecret, openUrlOf, redirectHash, secretMatches } from '../../src/server/http/cli-secret.ts';

describe('per-run secret of the CLI', () => {
    it('a new secret per call: 32 random bytes in base64url (cookie- and URL-safe)', () => {
        const a = newSecret();
        expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(newSecret()).not.toBe(a);
    });

    it('matches only the exact secret', () => {
        expect(secretMatches('abc', 'abc')).toBe(true);
        for (const given of ['abd', 'ab', 'abcd', '', undefined, 'ABC']) {
            expect(secretMatches('abc', given), String(given)).toBe(false);
        }
    });

    it('redirect target: a same-page #/ hash, anything else gives the home', () => {
        expect(redirectHash('#/pr/acme/records-api/12')).toBe('#/pr/acme/records-api/12');
        expect(redirectHash('#/pr/acme/records-api/12?from=1&to=3')).toBe('#/pr/acme/records-api/12?from=1&to=3');
        expect(redirectHash('#/')).toBe('#/');
        for (const to of [undefined, '', '#', '#x', 'https://evil.example', '//evil.example', '/#/pr/a/b/1', '#/a b', '#/a\r\nX: y', '#/é', 'javascript:alert(1)']) {
            expect(redirectHash(to), String(to)).toBe('');
        }
    });

    it('open URL: ?k= with the hash as to= when a secret is set, the plain page address otherwise', () => {
        const base = 'http://127.0.0.1:7420';
        expect(openUrlOf(base, 'k-1_x', '')).toBe(`${base}/open?k=k-1_x`);
        expect(openUrlOf(base, 'k-1_x', '#/pr/acme/records-api/12')).toBe(`${base}/open?k=k-1_x&to=%23%2Fpr%2Facme%2Frecords-api%2F12`);
        expect(openUrlOf(base, null, '')).toBe(`${base}/`);
        expect(openUrlOf(base, null, '#/pr/acme/records-api/12')).toBe(`${base}/#/pr/acme/records-api/12`);
    });
});
