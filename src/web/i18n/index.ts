// Current page locale (reactive): components call t() / tr() in templates and computed values, which re-render
// when the locale changes. Pure functions of src/web/lib receive the translator as an argument instead.
import { readonly, ref } from 'vue';
import type { MessageKey } from './en.ts';
import { createTranslator, type ParamArgs, type Translator } from './translator.ts';
import type { Locale } from './types.ts';

export type { MessageKey } from './en.ts';
export type { Translator } from './translator.ts';
export type { Locale } from './types.ts';
export { detectLocale } from './translator.ts';

const current = ref<Locale>('en');
const translators = new Map<Locale, Translator>();

/** Current locale (read-only; change it with setLocale). */
export const locale = readonly(current);

/** Translator of a locale (cached). */
export function translatorFor(value: Locale): Translator {
    let translator = translators.get(value);
    if (!translator) {
        translator = createTranslator(value);
        translators.set(value, translator);
    }
    return translator;
}

/** Changes the page language; <html lang> follows. */
export function setLocale(value: Locale): void {
    current.value = value;
    if (typeof document !== 'undefined') {
        document.documentElement.lang = value;
    }
}

/** Translator of the current locale (reactive read). */
export function tr(): Translator {
    return translatorFor(current.value);
}

/** Translated text in the current locale (reactive read). */
export function t<K extends MessageKey>(key: K, ...params: ParamArgs<K>): string {
    return tr().t(key, ...params);
}
