// Small classification rules: file category, abbreviated hashes.
import type { FileCategory } from '../../shared/api.ts';

const DEPS_PATTERNS = [
    /(^|\/)package\.json$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)npm-shrinkwrap\.json$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)pnpm-lock\.yaml$/,
];

/** "deps" for manifests and lockfiles, "code" otherwise. */
export function categoryOf(path: string): FileCategory {
    return DEPS_PATTERNS.some((re) => re.test(path)) ? 'deps' : 'code';
}

/** Same commit (hashes in Bitbucket activity are abbreviated to 12 characters). */
export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    return a.startsWith(b) || b.startsWith(a);
}
