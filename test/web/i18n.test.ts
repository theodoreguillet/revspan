import { computed, nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../../src/web/i18n/en.ts';
import { fr } from '../../src/web/i18n/fr.ts';
import { locale, setLocale, t, tr } from '../../src/web/i18n/index.ts';
import { createTranslator, detectLocale, fillTemplate, placeholders, selectPlural } from '../../src/web/i18n/translator.ts';
import type { Entry } from '../../src/web/i18n/types.ts';
import { readInitialLocale } from '../../src/web/services/host.ts';

const frT = createTranslator('fr');
const enT = createTranslator('en');

describe('interpolation', () => {
    it('replaces named placeholders, keeps unknown ones as is', () => {
        expect(fillTemplate('{a} → {b}', { a: 'v1', b: 2 }, 'en')).toEqual(['v1 → 2']);
        expect(fillTemplate('{a} and {missing}', { a: 'x' }, 'en')).toEqual(['x and {missing}']);
    });

    it('formats {count} as a localized number, other numbers as plain digits (line, version)', () => {
        expect(fillTemplate('{count} / line {line}', { count: 12345, line: 12345 }, 'en')).toEqual(['12,345 / line 12345']);
        expect(fillTemplate('{count}', { count: 12345 }, 'fr')).toEqual(['12 345']);
    });

    it('keeps non-text values as separate parts (rich text, slots)', () => {
        const bold = { bold: 'v10' };
        expect(fillTemplate('{v} : {rest}.', { v: bold, rest: 'ok' }, 'fr')).toEqual([bold, ' : ok.']);
    });

    it('t() with catalog entries', () => {
        expect(frT.t('readout.changesFromTo', { from: 'v4', to: 'v9' })).toBe('Changements de v4 à v9');
        expect(enT.t('readout.changesFromTo', { from: 'v4', to: 'v9' })).toBe('Changes from v4 to v9');
        expect(enT.t('common.close')).toBe('Close');
    });
});

describe('plurals', () => {
    it('French: 0 and 1 are singular', () => {
        expect(selectPlural({ one: 'one', other: 'other' }, 0, 'fr')).toBe('one');
        expect(selectPlural({ one: 'one', other: 'other' }, 1, 'fr')).toBe('one');
        expect(selectPlural({ one: 'one', other: 'other' }, 2, 'fr')).toBe('other');
        expect(frT.t('common.versions', { count: 0 })).toBe('0 version');
        expect(frT.t('common.versions', { count: 1 })).toBe('1 version');
        expect(frT.t('common.versions', { count: 3 })).toBe('3 versions');
    });

    it('English: only 1 is singular', () => {
        expect(selectPlural({ one: 'one', other: 'other' }, 0, 'en')).toBe('other');
        expect(enT.t('common.versions', { count: 0 })).toBe('0 versions');
        expect(enT.t('common.versions', { count: 1 })).toBe('1 version');
        expect(enT.t('banner.newReplies', { count: 2 })).toBe('2 new replies');
    });

    it('a category missing from the entry falls back to « other » (French « many » for millions)', () => {
        expect(selectPlural({ one: 'one', other: 'other' }, 1_000_000, 'fr')).toBe('other');
    });
});

describe('lists, dates and numbers follow the locale', () => {
    it('lists', () => {
        expect(frT.list(['a', 'b', 'c'])).toBe('a, b et c');
        expect(enT.list(['a', 'b'])).toBe('a and b');
        expect(enT.list(['a'])).toBe('a');
        expect(frT.list([])).toBe('');
    });

    it('list parts keep the elements apart (monospace file names)', () => {
        expect(frT.listParts(['a', 'b', 'c'])).toEqual([{ element: 'a' }, ', ', { element: 'b' }, ' et ', { element: 'c' }]);
    });

    it('dates and numbers', () => {
        const date = new Date('2026-10-14T09:10:00Z');
        expect(frT.date(date, { day: 'numeric', month: 'short', timeZone: 'UTC' })).toBe('14 oct.');
        expect(enT.date(date, { day: 'numeric', month: 'short', timeZone: 'UTC' })).toBe('Oct 14');
        expect(enT.number(1234)).toBe('1,234');
    });
});

describe('locale detection', () => {
    it('browser language: fr* → French, anything else → English', () => {
        expect(detectLocale({ browser: ['fr-FR', 'en'] })).toBe('fr');
        expect(detectLocale({ browser: ['fr'] })).toBe('fr');
        expect(detectLocale({ browser: ['FR-ca'] })).toBe('fr');
        expect(detectLocale({ browser: ['en-GB', 'fr'] })).toBe('en');
        expect(detectLocale({ browser: ['de-DE'] })).toBe('en');
        expect(detectLocale({ browser: [] })).toBe('en');
        expect(detectLocale({})).toBe('en');
    });

    it('the host language (VS Code) wins over the browser', () => {
        expect(detectLocale({ host: 'fr', browser: ['en-US'] })).toBe('fr');
        expect(detectLocale({ host: 'en', browser: ['fr-FR'] })).toBe('en');
        expect(detectLocale({ host: 'de', browser: ['fr-FR'] })).toBe('en');
        expect(detectLocale({ host: '  ', browser: ['fr-FR'] })).toBe('fr');
        expect(detectLocale({ host: null, browser: ['fr-FR'] })).toBe('fr');
    });

    it('host language given by the extension in a <meta> tag', () => {
        const doc = (head: string): Document => new DOMParser().parseFromString(`<html><head>${head}</head><body></body></html>`, 'text/html');
        expect(readInitialLocale(doc('<meta name="revspan-locale" content=" fr ">'))).toBe('fr');
        expect(readInitialLocale(doc('<meta name="revspan-locale" content="">'))).toBeNull();
        expect(readInitialLocale(doc(''))).toBeNull();
    });
});

describe('catalogs', () => {
    const kind = (entry: Entry): string => (typeof entry === 'string' ? 'text' : 'plural');
    const names = (entry: Entry): string[] => [...placeholders(entry)].sort();

    it('same keys in French and English', () => {
        expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    });

    it('each entry has the same kind (text or plural) and the same placeholders in both languages', () => {
        for (const key of Object.keys(en) as (keyof typeof en)[]) {
            expect(kind(fr[key]), key).toBe(kind(en[key]));
            expect(names(fr[key]), key).toEqual(names(en[key]));
        }
    });

    it('no empty text', () => {
        for (const catalog of [en, fr]) {
            for (const [key, entry] of Object.entries(catalog) as [string, Entry][]) {
                const texts: string[] = typeof entry === 'string' ? [entry] : Object.values(entry);
                expect(texts.every((text) => text.trim() !== ''), key).toBe(true);
            }
        }
    });
});

describe('current locale', () => {
    afterEach(() => setLocale('en'));

    it('is reactive and drives <html lang>', async () => {
        setLocale('en');
        const label = computed(() => t('common.close'));
        const listed = computed(() => tr().list(['a', 'b']));
        expect(label.value).toBe('Close');
        setLocale('fr');
        await nextTick();
        expect(locale.value).toBe('fr');
        expect(label.value).toBe('Fermer');
        expect(listed.value).toBe('a et b');
        expect(document.documentElement.lang).toBe('fr');
    });
});
