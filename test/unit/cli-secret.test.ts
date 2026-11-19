import { describe, expect, it } from 'vitest';
import { newSecret, openUrlOf, portFallbackWarning, redirectHash, secretCookie, secretMatches } from '../../src/server/http/cli-secret.ts';

describe('per-run secret of the CLI', () => {
    it('a new secret per call: 32 random bytes in base64url (cookie- and URL-safe)', () => {
        const a = newSecret();
        expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(newSecret()).not.toBe(a);
    });

    it('one cookie name per port, so two local servers never overwrite each other\'s cookie', () => {
        expect(secretCookie(7420)).toBe('revspan_k_7420');
        expect(secretCookie('7421')).toBe('revspan_k_7421');
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

    it('preferred port taken: a loud warning naming both ports and why the taken one must not be opened', () => {
        expect(portFallbackWarning(7420, 7420)).toBeNull();
        expect(portFallbackWarning(0, 51234)).toBeNull();
        const warning = portFallbackWarning(7420, 7421) ?? '';
        expect(warning).toMatch(/^WARNING: port 7420 is used by another program; Revspan runs on port 7421 instead\./);
        expect(warning).toContain('Do not open http://127.0.0.1:7420');
        expect(warning).toContain('cookie');
    });
});
