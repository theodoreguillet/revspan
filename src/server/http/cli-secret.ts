// Per-run secret of the command line (CLI only; the VS Code extension serves the API in memory, with no secret).
// The CLI opens /open?k=<secret>, the server trades it for an HttpOnly cookie, and every /api call must carry that cookie:
// another local user can neither read the API nor act as the user, even on 127.0.0.1.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cookie that carries the secret (HttpOnly, SameSite=Strict, Path=/), named after the server's port: browsers send the
 * cookies of 127.0.0.1 to every port, so two local servers must not overwrite each other's.
 */
export const secretCookie = (port: number | string): string => `revspan_k_${port}`;

/** A new secret: 32 random bytes in base64url (safe in a URL and in a cookie). */
export const newSecret = (): string => randomBytes(32).toString('base64url');

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

/** Constant-time comparison (fixed-size digests: neither the content nor the length of the secret leaks). */
export function secretMatches(secret: string, given: string | undefined): boolean {
    return given !== undefined && timingSafeEqual(digest(secret), digest(given));
}

// A hash of the page, in visible ASCII only (what encodeURIComponent produces): never a URL of another site.
const PAGE_HASH = /^#\/[!-~]*$/;

/** Where /open?k= may redirect: a same-page hash (#/…), else '' (the home). */
export const redirectHash = (to: string | undefined): string => (to !== undefined && PAGE_HASH.test(to) ? to : '');

/**
 * The preferred port was taken and the server fell back to another one: the program on the preferred port would receive
 * the Revspan cookie if the browser opened it (cookies are sent to every port of 127.0.0.1). null when nothing to say.
 */
export function portFallbackWarning(preferred: number, actual: number): string | null {
    if (preferred === 0 || preferred === actual) {
        return null;
    }
    return `WARNING: port ${preferred} is used by another program; Revspan runs on port ${actual} instead. `
        + `Do not open http://127.0.0.1:${preferred} in this browser: it is not Revspan, and the browser would send it your Revspan cookie.`;
}

/** Address the CLI opens: /open?k=<secret>[&to=<hash>] with a secret, the page itself otherwise. */
export function openUrlOf(base: string, secret: string | null, hash: string): string {
    if (!secret) {
        return `${base}/${hash}`;
    }
    return `${base}/open?k=${encodeURIComponent(secret)}${hash ? `&to=${encodeURIComponent(hash)}` : ''}`;
}
