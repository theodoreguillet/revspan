// Shared i18n types (no imports, so the catalogs and the translator can both use them).

export type Locale = 'en' | 'fr';

export const LOCALES: readonly Locale[] = ['en', 'fr'];

/** Plural forms of an entry, chosen with Intl.PluralRules; a missing category falls back to `other`. */
export interface PluralForms {
    readonly one: string;
    readonly other: string;
    readonly zero?: string;
    readonly two?: string;
    readonly few?: string;
    readonly many?: string;
}

/** A catalog entry: plain text or plural forms. Placeholders are written `{name}`; `{count}` selects the plural form. */
export type Entry = string | PluralForms;
