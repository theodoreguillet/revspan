// Range of compared versions: click rules, default range, presets, reading text.
import type { Version } from '../../shared/api.ts';
import type { MessageKey, Translator } from '../i18n/index.ts';
import { MINUS, vname } from './format.ts';
import { CODE_KINDS, type SummaryMap } from './kinds.ts';

/** from = reference version (0 = master base), to = displayed version; 0 <= from < to <= n. */
export interface Range {
    from: number;
    to: number;
}

/** Unavailable versions (commit erased by Bitbucket): neither selectable nor comparable. */
export type Unavailable = ReadonlySet<number>;
const NONE: Unavailable = new Set();

export function unavailableVersions(versions: readonly Pick<Version, 'index' | 'available'>[]): Set<number> {
    return new Set(versions.filter((v) => !v.available).map((v) => v.index));
}

/** "from" bound brought back to the last readable version <= k (0 = master base). */
export function floorAvailable(k: number, unavailable: Unavailable = NONE): number {
    let index = k;
    while (index > 0 && unavailable.has(index)) {
        index--;
    }
    return index;
}

/** New range after a click (Shift = extend) on version i (0 = master); an unavailable version does nothing. */
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
    // inside the range: move the closest bound
    return i - from <= to - i ? { from: before, to } : { from, to: i };
}

/** Default range when a PR is opened. */
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
 * Range after a detail reload (version discovered erased by Bitbucket): kept if still valid;
 * otherwise "from" moves back to the last readable version; if "to" is hit, default range.
 */
export function repairSelection(n: number, range: Range, lastReviewed: number | null, unavailable: Unavailable = NONE): Range {
    if (isValidSelection(n, range.from, range.to, unavailable)) {
        return range;
    }
    const from = floorAvailable(range.from, unavailable);
    return isValidSelection(n, from, range.to, unavailable) ? { from, to: range.to } : defaultSelection(n, lastReviewed, unavailable);
}

/** Selection of a single version i: (last readable before i -> i), clamped to 1..n. */
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

/** Reading text of the range: { bold, rest }. */
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

/** Reads from/to from the route parameters (digit strings only). */
export function parseRangeQuery(query: Record<string, unknown>): { from: number | null; to: number | null } {
    const num = (value: unknown): number | null => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null);
    return { from: num(query.from), to: num(query.to) };
}
