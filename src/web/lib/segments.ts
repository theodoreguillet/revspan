// Texte enrichi minimal produit par la logique (bandeau, onglet Versions) et rendu par <SegText>.
import type { MessageKey, Translator } from '../i18n/index.ts';
import type { ParamName, ParamValue } from '../i18n/translator.ts';

export type SegKind = 'b' | 'mono' | 'add' | 'del';
export type Seg = string | { text: string; kind: SegKind };

export const b = (text: string): Seg => ({ text, kind: 'b' });
export const mono = (text: string): Seg => ({ text, kind: 'mono' });
export const add = (text: string): Seg => ({ text, kind: 'add' });
export const del = (text: string): Seg => ({ text, kind: 'del' });

/** Texte brut (pour les tests et les infobulles). */
export function segText(segs: Seg[]): string {
    return segs.map((s) => (typeof s === 'string' ? s : s.text)).join('');
}

/** Wraps a segment list so it can travel through a translated template as a single placeholder value. */
interface SegGroup {
    group: Seg[];
}

/**
 * Translated message as segments: placeholders take plain values (text, numbers) or segment lists
 * (`{ version: [b('v10')] }`), so bold or monospace parts keep their place in any language's word order.
 */
export function tSegs<K extends MessageKey>(tr: Translator, key: K, params: Record<ParamName<K>, ParamValue | Seg[]>): Seg[] {
    const wrapped = Object.fromEntries(Object.entries(params).map(([name, value]) => [name, Array.isArray(value) ? { group: value } : value]));
    return tr.parts<K, SegGroup>(key, wrapped as Record<ParamName<K>, ParamValue | SegGroup>)
        .flatMap((part) => (typeof part === 'string' ? (part ? [part] : []) : part.group));
}
