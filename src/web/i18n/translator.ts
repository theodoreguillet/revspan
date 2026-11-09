// Translator for one locale: catalog lookup, interpolation, plurals, and Intl formatting (lists, dates, numbers).
// Pure and dependency-free: the reactive current locale lives in index.ts.
import { en, type Catalog, type MessageKey } from './en.ts';
import { fr } from './fr.ts';
import type { Entry, Locale, PluralForms } from './types.ts';

const CATALOGS: Record<Locale, Catalog> = { en, fr };

/** BCP 47 tag used by Intl for each locale. */
const INTL_TAGS: Record<Locale, string> = { en: 'en-US', fr: 'fr-FR' };

// ---------- Typed parameters ----------

type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never;
type EntryPlaceholders<E> = E extends string
    ? Placeholders<E>
    : E extends PluralForms ? Placeholders<E[keyof E]> | 'count' : never;

/** Placeholder names of a message (from the English reference catalog). */
export type ParamName<K extends MessageKey> = EntryPlaceholders<(typeof en)[K]>;
export type ParamValue = string | number;
export type Params<K extends MessageKey> = Record<ParamName<K>, ParamValue>;
/** No argument for a message without placeholders, otherwise every placeholder is required. */
export type ParamArgs<K extends MessageKey> = [ParamName<K>] extends [never] ? [] : [params: Params<K>];

/** A list part: an element (item of the list) or the literal text between elements. */
export type ListPart = string | { element: string };

export interface Translator {
    readonly locale: Locale;
    /** Translated text, placeholders filled. */
    t<K extends MessageKey>(key: K, ...params: ParamArgs<K>): string;
    /**
     * Same, but non-text values (rich-text segments, slot markers) are kept as separate parts instead of being
     * stringified: `parts('x', { v: bold })` → `[bold, ' : …']`.
     */
    parts<K extends MessageKey, V extends object>(key: K, params: Record<ParamName<K>, ParamValue | V>): (string | V)[];
    /** « a, b et c » / « a, b, and c ». */
    list(items: readonly string[]): string;
    listParts(items: readonly string[]): ListPart[];
    /** Quantity with locale grouping. */
    number(value: number): string;
    date(value: Date, options: Intl.DateTimeFormatOptions): string;
}

// ---------- Pure helpers (exported for tests) ----------

const PLACEHOLDER = /\{(\w+)\}/g;

const pluralRules = new Map<Locale, Intl.PluralRules>();
const numberFormats = new Map<Locale, Intl.NumberFormat>();

function rulesFor(locale: Locale): Intl.PluralRules {
    let rules = pluralRules.get(locale);
    if (!rules) {
        rules = new Intl.PluralRules(INTL_TAGS[locale]);
        pluralRules.set(locale, rules);
    }
    return rules;
}

function numberFormat(locale: Locale): Intl.NumberFormat {
    let format = numberFormats.get(locale);
    if (!format) {
        format = new Intl.NumberFormat(INTL_TAGS[locale]);
        numberFormats.set(locale, format);
    }
    return format;
}

/** Plural form for `count` (French: 0 and 1 are singular; English: only 1). */
export function selectPlural(forms: PluralForms, count: number, locale: Locale): string {
    const category = rulesFor(locale).select(count) as keyof PluralForms;
    return forms[category] ?? forms.other;
}

/**
 * Fills `{name}` placeholders. Strings are inserted as is, `{count}` is formatted as a quantity, other numbers as plain
 * digits (line and version numbers), and objects are kept as separate parts. Unknown placeholders are left untouched.
 */
export function fillTemplate<V extends object>(template: string, params: Readonly<Record<string, ParamValue | V>>, locale: Locale): (string | V)[] {
    const out: (string | V)[] = [];
    let text = '';
    let last = 0;
    for (const match of template.matchAll(PLACEHOLDER)) {
        const [whole, name = ''] = match;
        text += template.slice(last, match.index);
        last = match.index + whole.length;
        const value = Object.hasOwn(params, name) ? params[name] : undefined;
        if (value === undefined) {
            text += whole;
        } else if (typeof value === 'string') {
            text += value;
        } else if (typeof value === 'number') {
            text += name === 'count' ? numberFormat(locale).format(value) : String(value);
        } else {
            if (text) {
                out.push(text);
            }
            text = '';
            out.push(value);
        }
    }
    text += template.slice(last);
    if (text || !out.length) {
        out.push(text);
    }
    return out;
}

/** Placeholder names used by an entry (all plural forms, plus `count` for plurals). */
export function placeholders(entry: Entry): Set<string> {
    const names = new Set<string>(typeof entry === 'string' ? [] : ['count']);
    for (const text of typeof entry === 'string' ? [entry] : Object.values(entry)) {
        for (const match of (text as string).matchAll(PLACEHOLDER)) {
            names.add(match[1] ?? '');
        }
    }
    return names;
}

const FRENCH_TAG = /^fr(?:[-_]|$)/i;

function localeOfTag(tag: string | null | undefined): Locale | null {
    const value = tag?.trim();
    if (!value) {
        return null;
    }
    return FRENCH_TAG.test(value) ? 'fr' : 'en';
}

/**
 * Page locale: the language imposed by the host (VS Code) if any, otherwise the browser's preferred language;
 * French for `fr*`, English for anything else.
 */
export function detectLocale({ host, browser }: { host?: string | null; browser?: readonly (string | null | undefined)[] }): Locale {
    return localeOfTag(host) ?? localeOfTag(browser?.find((tag) => !!tag?.trim())) ?? 'en';
}

// ---------- Translator ----------

export function createTranslator(locale: Locale): Translator {
    const catalog = CATALOGS[locale];
    const tag = INTL_TAGS[locale];
    const listFormat = new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' });
    const dateFormats = new Map<string, Intl.DateTimeFormat>();

    function template(key: MessageKey, params: Readonly<Record<string, unknown>>): string {
        const entry: Entry = catalog[key] ?? en[key];
        if (typeof entry === 'string') {
            return entry;
        }
        const count = params.count;
        return typeof count === 'number' ? selectPlural(entry, count, locale) : entry.other;
    }

    function parts<K extends MessageKey, V extends object>(key: K, params: Record<ParamName<K>, ParamValue | V>): (string | V)[] {
        return fillTemplate<V>(template(key, params), params, locale);
    }

    return {
        locale,
        t: (key, ...args) => {
            const params: Readonly<Record<string, ParamValue>> = args[0] ?? {};
            return fillTemplate<never>(template(key, params), params, locale).join('');
        },
        parts,
        list: (items) => listFormat.format(items),
        listParts: (items) => listFormat.formatToParts(items).map((part) => (part.type === 'element' ? { element: part.value } : part.value)),
        number: (value) => numberFormat(locale).format(value),
        date: (value, options) => {
            const key = JSON.stringify(options);
            let format = dateFormats.get(key);
            if (!format) {
                format = new Intl.DateTimeFormat(tag, options);
                dateFormats.set(key, format);
            }
            return format.format(value);
        },
    };
}
