// Petites règles de classement : catégorie de fichier, hashes abrégés.
import type { FileCategory } from '../../shared/api.ts';

const DEPS_PATTERNS = [
    /(^|\/)package\.json$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)npm-shrinkwrap\.json$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)pnpm-lock\.yaml$/,
];

/** « deps » pour les manifestes et lockfiles, « code » sinon. */
export function categoryOf(path: string): FileCategory {
    return DEPS_PATTERNS.some((re) => re.test(path)) ? 'deps' : 'code';
}

/** Même commit (les hashes de l'activité Bitbucket sont abrégés à 12 caractères). */
export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    return a.startsWith(b) || b.startsWith(a);
}
