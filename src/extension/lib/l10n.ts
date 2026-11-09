// Localization for the extension's pure code: the host gives it vscode.l10n.t and VS Code's display language.
// English messages stay in the code and are the keys of the French bundle (extension/l10n/bundle.l10n.fr.json).

/** Same contract as vscode.l10n.t: the English message is the key, `{name}` placeholders are filled from args. */
export type Translate = (message: string, args?: Record<string, string | number>) => string;

/** Languages of the webview page (Task 6 catalogs). */
export type PageLocale = 'en' | 'fr';

const FRENCH_TAG = /^fr(?:[-_]|$)/i;

/** Page language for VS Code's display language (vscode.env.language): French for fr*, English otherwise. */
export function pageLocale(language: string): PageLocale {
    return FRENCH_TAG.test(language.trim()) ? 'fr' : 'en';
}

export interface L10n {
    t: Translate;
    /** Whether this count takes the singular form in the language of the texts (French: 0 and 1, English: 1). */
    isSingular(count: number): boolean;
}

/** The texts exist in French and English only: an untranslated display language gets English plural rules. */
export function createL10n(t: Translate, language: string): L10n {
    const rules = new Intl.PluralRules(pageLocale(language));
    return { t, isSingular: (count) => rules.select(count) === 'one' };
}
