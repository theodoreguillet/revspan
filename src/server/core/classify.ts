// Petites règles de classement : catégorie de fichier, réactions, hashes abrégés.
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

// Réponses traitées comme des réactions (l'API Bitbucket n'expose pas de vraies réactions).
const REACTION_ALIASES = new Map<string, string>([
    ['👍', '👍'], [':+1:', '👍'], [':thumbsup:', '👍'], ['+1', '👍'], ['(y)', '👍'],
    ['👏', '👏'], ['🎉', '🎉'], ['❤️', '❤️'], ['🚀', '🚀'], ['👀', '👀'], ['✅', '✅'],
]);

export function reactionOf(raw: unknown): string | null {
    return typeof raw === 'string' ? REACTION_ALIASES.get(raw.trim()) ?? null : null;
}

/** Même commit (les hashes de l'activité Bitbucket sont abrégés à 12 caractères). */
export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    return a.startsWith(b) || b.startsWith(a);
}
