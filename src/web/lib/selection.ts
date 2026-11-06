// Plage de versions comparées : règles de clic, plage par défaut, préréglages, texte de lecture.
import type { Version } from '../../shared/api.ts';
import { MINUS, plural, vname } from './format.ts';
import { CODE_KINDS, type SummaryMap } from './kinds.ts';

/** from = version de référence (0 = base master), to = version affichée ; 0 ≤ from < to ≤ n. */
export interface Range {
    from: number;
    to: number;
}

/** Nouvelle plage après un clic (Maj = étendre) sur la version i (0 = master). */
export function clickSelection({ from, to }: Range, i: number, shift: boolean): Range {
    if (i === 0) {
        return { from: 0, to };
    }
    if (!shift) {
        return { from: i - 1, to: i };
    }
    if (i > to) {
        return { from, to: i };
    }
    if (i <= from) {
        return { from: i - 1, to };
    }
    // dans la plage : on déplace la borne la plus proche
    return i - from <= to - i ? { from: i - 1, to } : { from, to: i };
}

/** Plage par défaut à l'ouverture d'une PR. */
export function defaultSelection(n: number, lastReviewed: number | null): Range {
    if (lastReviewed != null && lastReviewed >= 1 && lastReviewed < n) {
        return { from: lastReviewed, to: n };
    }
    if (lastReviewed != null && lastReviewed >= n && n > 1) {
        return { from: n - 1, to: n };
    }
    return { from: 0, to: n };
}

export function isValidSelection(n: number, from: number | null, to: number | null): boolean {
    return from != null && to != null && Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= n && from < to;
}

/** Sélection d'une seule version i : (i-1 → i), bornée à 1..n. */
export function singleVersion(n: number, i: number): Range {
    const v = Math.min(Math.max(i, 1), n);
    return { from: v - 1, to: v };
}

export type PresetKey = 'since' | 'last' | 'all';

export interface Preset extends Range {
    key: PresetKey;
    label: string;
}

export function presets(n: number, lastReviewed: number | null): Preset[] {
    const out: Preset[] = [];
    if (lastReviewed != null && lastReviewed >= 1 && lastReviewed < n) {
        out.push({ key: 'since', label: 'Depuis ma relecture', from: lastReviewed, to: n });
    }
    if (n > 1) {
        out.push({ key: 'last', label: 'Dernière version', from: n - 1, to: n });
    }
    out.push({ key: 'all', label: 'Tout vs master', from: 0, to: n });
    return out;
}

export interface ReadoutInput extends Range {
    versions: Version[];
    sums: SummaryMap;
    stats: { files: number; added: number; removed: number } | null;
    destBranch?: string;
}

/** Texte de lecture de la plage : { bold, rest }. */
export function readout({ from, to, versions, sums, stats, destBranch = 'master' }: ReadoutInput): { bold: string; rest: string } {
    if (from === 0) {
        let rest = `· par rapport à sa base sur ${destBranch}`;
        if (stats) {
            rest += ` · ${plural(stats.files, 'fichier')}, +${stats.added} ${MINUS}${stats.removed}`;
        }
        return { bold: `${vname(to)} complète`, rest };
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
        ? `${code.slice(0, 5).map(vname).join(', ')}… (${code.length} versions)`
        : code.map(vname).join(', ');
    let rest = `· par rapport à ${vname(from)}`;
    let bold: string;
    if (to - from === 1) {
        bold = `Changements de ${vname(to)}`;
        if (known && !code.length) {
            rest += ' · aucun changement de code';
        }
    } else {
        bold = `Changements de ${vname(from + 1)} à ${vname(to)}`;
        if (known) {
            rest += code.length ? ` · code modifié en ${codeList}` : ' · aucun changement de code';
        }
    }
    if (rebases) {
        rest += ` · ${plural(rebases, 'rebase')}`;
    }
    return { bold, rest };
}

/** Lit from/to dans les paramètres de route (chaînes de chiffres seulement). */
export function parseRangeQuery(query: Record<string, unknown>): { from: number | null; to: number | null } {
    const num = (value: unknown): number | null => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null);
    return { from: num(query.from), to: num(query.to) };
}
