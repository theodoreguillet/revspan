// Plage de versions comparées : règles de clic, plage par défaut, préréglages, texte de lecture.
import type { Version } from '../../shared/api.ts';
import type { MessageKey, Translator } from '../i18n/index.ts';
import { MINUS, vname } from './format.ts';
import { CODE_KINDS, type SummaryMap } from './kinds.ts';

/** from = version de référence (0 = base master), to = version affichée ; 0 ≤ from < to ≤ n. */
export interface Range {
    from: number;
    to: number;
}

/** Versions indisponibles (commit effacé par Bitbucket) : ni sélectionnables ni comparables. */
export type Unavailable = ReadonlySet<number>;
const NONE: Unavailable = new Set();

export function unavailableVersions(versions: readonly Pick<Version, 'index' | 'available'>[]): Set<number> {
    return new Set(versions.filter((v) => !v.available).map((v) => v.index));
}

/** Borne « de » ramenée sur la dernière version lisible ≤ k (0 = base master). */
export function floorAvailable(k: number, unavailable: Unavailable = NONE): number {
    let index = k;
    while (index > 0 && unavailable.has(index)) {
        index--;
    }
    return index;
}

/** Nouvelle plage après un clic (Maj = étendre) sur la version i (0 = master) ; une version indisponible ne fait rien. */
export function clickSelection({ from, to }: Range, i: number, shift: boolean, unavailable: Unavailable = NONE): Range {
    if (i === 0) {
        return { from: 0, to };
    }
    if (unavailable.has(i)) {
        return { from, to };
    }
    const before = floorAvailable(i - 1, unavailable);
    if (!shift) {
        return { from: before, to: i };
    }
    if (i > to) {
        return { from, to: i };
    }
    if (i <= from) {
        return { from: before, to };
    }
    // dans la plage : on déplace la borne la plus proche
    return i - from <= to - i ? { from: before, to } : { from, to: i };
}

/** Plage par défaut à l'ouverture d'une PR. */
export function defaultSelection(n: number, lastReviewed: number | null, unavailable: Unavailable = NONE): Range {
    if (lastReviewed != null && lastReviewed >= 1 && lastReviewed < n) {
        return { from: floorAvailable(lastReviewed, unavailable), to: n };
    }
    if (lastReviewed != null && lastReviewed >= n && n > 1) {
        return { from: floorAvailable(n - 1, unavailable), to: n };
    }
    return { from: 0, to: n };
}

export function isValidSelection(n: number, from: number | null, to: number | null, unavailable: Unavailable = NONE): boolean {
    return from != null && to != null && Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= n && from < to
        && !unavailable.has(from) && !unavailable.has(to);
}

/**
 * Plage après un rechargement du détail (version découverte effacée par Bitbucket) : gardée si elle reste valide ;
 * sinon « de » recule jusqu'à la dernière version lisible ; si « à » est touchée, plage par défaut.
 */
export function repairSelection(n: number, range: Range, lastReviewed: number | null, unavailable: Unavailable = NONE): Range {
    if (isValidSelection(n, range.from, range.to, unavailable)) {
        return range;
    }
    const from = floorAvailable(range.from, unavailable);
    return isValidSelection(n, from, range.to, unavailable) ? { from, to: range.to } : defaultSelection(n, lastReviewed, unavailable);
}

/** Sélection d'une seule version i : (dernière lisible avant i → i), bornée à 1..n. */
export function singleVersion(n: number, i: number, unavailable: Unavailable = NONE): Range {
    const v = Math.min(Math.max(i, 1), n);
    return { from: floorAvailable(v - 1, unavailable), to: v };
}

export type PresetKey = 'since' | 'last' | 'all';

export interface Preset extends Range {
    key: PresetKey;
}

/** Label of each preset button. */
export const PRESET_LABELS = { since: 'preset.since', last: 'preset.last', all: 'preset.all' } as const satisfies Record<PresetKey, MessageKey>;

export function presets(n: number, lastReviewed: number | null, unavailable: Unavailable = NONE): Preset[] {
    const out: Preset[] = [];
    if (lastReviewed != null && lastReviewed >= 1 && lastReviewed < n) {
        out.push({ key: 'since', from: floorAvailable(lastReviewed, unavailable), to: n });
    }
    if (n > 1) {
        out.push({ key: 'last', from: floorAvailable(n - 1, unavailable), to: n });
    }
    out.push({ key: 'all', from: 0, to: n });
    return out;
}

export interface ReadoutInput extends Range {
    versions: Version[];
    sums: SummaryMap;
    stats: { files: number; added: number; removed: number } | null;
    destBranch?: string;
}

/** Texte de lecture de la plage : { bold, rest }. */
export function readout(tr: Translator, { from, to, versions, sums, stats, destBranch = 'master' }: ReadoutInput): { bold: string; rest: string } {
    if (from === 0) {
        const rest = [tr.t('readout.againstBase', { branch: destBranch })];
        if (stats) {
            rest.push(`${tr.t('common.files', { count: stats.files })}, +${stats.added} ${MINUS}${stats.removed}`);
        }
        return { bold: tr.t('readout.full', { version: vname(to) }), rest: `· ${rest.join(' · ')}` };
    }
    let rebases = 0;
    let known = true;
    const code: number[] = [];
    for (let i = from + 1; i <= to; i++) {
        if (versions[i - 1]?.isRebase) {
            rebases++;
        }
        const sum = sums.get(i);
        if (!sum) {
            known = false;
        } else if (CODE_KINDS.has(sum.kind)) {
            code.push(i);
        }
    }
    const codeList = code.length > 6
        ? tr.t('readout.manyVersions', { versions: code.slice(0, 5).map(vname).join(', '), count: code.length })
        : code.map(vname).join(', ');
    const rest = [tr.t('readout.against', { version: vname(from) })];
    let bold: string;
    if (to - from === 1) {
        bold = tr.t('readout.changesOf', { version: vname(to) });
        if (known && !code.length) {
            rest.push(tr.t('readout.noCodeChanges'));
        }
    } else {
        bold = tr.t('readout.changesFromTo', { from: vname(from + 1), to: vname(to) });
        if (known) {
            rest.push(code.length ? tr.t('readout.codeChangedIn', { versions: codeList }) : tr.t('readout.noCodeChanges'));
        }
    }
    if (rebases) {
        rest.push(tr.t('common.rebases', { count: rebases }));
    }
    return { bold, rest: `· ${rest.join(' · ')}` };
}

/** Lit from/to dans les paramètres de route (chaînes de chiffres seulement). */
export function parseRangeQuery(query: Record<string, unknown>): { from: number | null; to: number | null } {
    const num = (value: unknown): number | null => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null);
    return { from: num(query.from), to: num(query.to) };
}
