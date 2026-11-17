// Version timeline: display model (days, gaps, folding of long PRs, hiding), deltas and tooltips.
import type { Version, VersionSummary } from '../../shared/api.ts';
import type { Translator } from '../i18n/index.ts';
import { dayKey, daysBetween, fmtDateTime, fmtDay, fmtMonth, gapLabel, isToday, MINUS } from './format.ts';
import { CODE_KINDS, isMuted, KIND_LABELS, type SummaryMap } from './kinds.ts';

export const MAX_VISIBLE_NODES = 12;

export type TimelineNode = { type: 'node'; version: Version } | { type: 'hidden'; list: number[] };

/** `after` = index of the version just before the item (used to color the range). */
export type TimelineItem =
    | { type: 'base' }
    | { type: 'day'; key: string; label: string; nodes: TimelineNode[] }
    | { type: 'gap'; label: string; after: number; days: number }
    | { type: 'sp'; after: number }
    | { type: 'seen'; after: number }
    | { type: 'fold'; a: number; b: number; months: string; codeCount: number | null; rebases: number };

export interface TimelineInput {
    versions: Version[];
    sums: SummaryMap;
    lastReviewed: number | null;
    from: number;
    to: number;
    hideNoCode: boolean;
    foldDisabled: boolean;
    maxVisible?: number;
}

export type NodeState = 'shown' | 'hidden' | 'folded';

export interface VersionNode {
    version: Version;
    state: NodeState;
}

/** State of each version: shown, hidden (no code) or folded (long PR). */
export function nodeStates({ versions, sums, lastReviewed, from, to, hideNoCode, foldDisabled, maxVisible = MAX_VISIBLE_NODES }: TimelineInput): VersionNode[] {
    const n = versions.length;
    const nodes: VersionNode[] = versions.map((version) => ({ version, state: 'shown' }));
    if (hideNoCode) {
        // never hidden: the bounds, the inside of the range, my last review
        for (const node of nodes) {
            const i = node.version.index;
            const keep = i === from || i === to || (i > from && i <= to) || i === lastReviewed;
            if (isMuted(sums.get(i)) && !keep) {
                node.state = 'hidden';
            }
        }
    }
    if (foldDisabled) {
        return nodes;
    }
    // never folded: after my review, the review itself, the bounds, the inside of the range
    // (except "full vN", whose inside is not a selection), the latest version
    const isProtected = (i: number): boolean => i === n || i === from || i === to
        || (lastReviewed != null && i >= lastReviewed)
        || (from > 0 && i > from && i < to);
    let visible = nodes.filter((node) => node.state === 'shown').length;
    for (const node of nodes) {
        if (visible <= maxVisible) {
            break;
        }
        if (isProtected(node.version.index)) {
            continue;
        }
        if (node.state === 'shown') {
            visible--;
        }
        node.state = 'folded';
    }
    // folding a single version brings nothing
    nodes.forEach((node, k) => {
        if (node.state === 'folded' && nodes[k - 1]?.state !== 'folded' && nodes[k + 1]?.state !== 'folded') {
            node.state = 'shown';
        }
    });
    return nodes;
}

/** Folding would hide at least one run of versions (so an expanded timeline can offer to fold again). */
export function canFold(input: TimelineInput): boolean {
    return nodeStates({ ...input, foldDisabled: false }).some((node) => node.state === 'folded');
}

/** Sequence of items to render from left to right. */
export function timelineModel(tr: Translator, input: TimelineInput): TimelineItem[] {
    const { sums, lastReviewed } = input;
    const items: TimelineItem[] = [{ type: 'base' }];
    let prevDay: string | null = null;
    let lastIdx = 0;
    let column: Extract<TimelineItem, { type: 'day' }> | null = null;
    let afterSeen = false;
    let foldRun: Version[] = [];

    const separate = (nextDay: string): void => {
        const days = prevDay ? daysBetween(prevDay, nextDay) : 0;
        items.push(days >= 2 ? { type: 'gap', label: gapLabel(tr, days), after: lastIdx, days } : { type: 'sp', after: lastIdx });
    };
    const flushFold = (): void => {
        const first = foldRun[0];
        const last = foldRun[foldRun.length - 1];
        if (!first || !last) {
            return;
        }
        separate(dayKey(first.pushedAt));
        const folded = foldRun.map((v) => sums.get(v.index));
        const codeCount = folded.every(Boolean) ? folded.filter((s) => s && CODE_KINDS.has(s.kind)).length : null;
        const m1 = fmtMonth(tr, first.pushedAt);
        const m2 = fmtMonth(tr, last.pushedAt);
        const rebases = foldRun.filter((v) => v.isRebase).length;
        items.push({ type: 'fold', a: first.index, b: last.index, months: m1 === m2 ? m1 : `${m1} → ${m2}`, codeCount, rebases });
        prevDay = dayKey(last.pushedAt);
        lastIdx = last.index;
        column = null;
        afterSeen = false;
        foldRun = [];
    };

    for (const { version, state } of nodeStates(input)) {
        if (state === 'folded') {
            foldRun.push(version);
            continue;
        }
        flushFold();
        const dk = dayKey(version.pushedAt);
        if (!column || column.key !== dk) {
            separate(dk);
            const label: string = afterSeen && prevDay === dk ? '' : `${fmtDay(tr, version.pushedAt)}${isToday(version.pushedAt) ? ` · ${tr.t('timeline.today')}` : ''}`;
            afterSeen = false;
            column = { type: 'day', key: dk, label, nodes: [] };
            items.push(column);
        }
        const last = column.nodes[column.nodes.length - 1];
        if (state === 'hidden' && last?.type === 'hidden') {
            last.list.push(version.index);
        } else {
            column.nodes.push(state === 'hidden' ? { type: 'hidden', list: [version.index] } : { type: 'node', version });
        }
        prevDay = dk;
        lastIdx = version.index;
        if (version.index === lastReviewed) {
            items.push({ type: 'seen', after: version.index });
            column = null;
            afterSeen = true;
        }
    }
    flushFold();
    return items;
}

/** An intermediate item (gap, space, reviewed) is in the range band. */
export const inBand = (after: number, from: number, to: number): boolean => after >= from && after < to;

export type NodeDelta = { code: true; added: number; removed: number } | { code: false; text: string };

/** Delta shown under a node: "+35 -14" for code, otherwise the type ("deps", "rebase only"...). */
export function nodeDelta(tr: Translator, sum: VersionSummary | undefined): NodeDelta {
    if (!sum) {
        return { code: false, text: '…' };
    }
    if (sum.kind === 'code') {
        return { code: true, added: sum.added, removed: sum.removed };
    }
    return { code: false, text: tr.t(KIND_LABELS[sum.kind]) };
}

/** Plain-words label of what a version is, for the tooltip's first line. */
function tipKind(tr: Translator, v: Version, sum: VersionSummary): string {
    switch (sum.kind) {
        case 'creation':
            return `${tr.t('timeline.tipCreation')} (+${sum.added} ${MINUS}${sum.removed})`;
        case 'code':
            return `${tr.t(v.isRebase ? 'timeline.tipRebaseCode' : 'timeline.tipCode')} (+${sum.added} ${MINUS}${sum.removed})`;
        case 'deps':
            return tr.t('timeline.tipDeps');
        case 'rebase-only':
            return tr.t('timeline.tipRebaseOnly');
        case 'message-only':
            return tr.t('timeline.tipMessageOnly');
        case 'unavailable':
            return tr.t('timeline.tipUnavailable');
        case 'none':
            return tr.t('timeline.tipNone');
    }
}

/** Tooltip of a node, two lines at most: what the version is, then its date and flags. The Versions tab has the detail. */
export function nodeTooltip(tr: Translator, v: Version, sum: VersionSummary | undefined, opts: { lastReviewed: number | null; n: number }): string {
    const first = [`v${v.index}`];
    if (!v.available) {
        first.push(tr.t('timeline.tipUnavailable'));
    } else if (sum) {
        first.push(tipKind(tr, v, sum));
        if (sum.conflicts) {
            first.push(tr.t('timeline.tipConflicts', { count: sum.conflicts }));
        }
    }
    const second = [fmtDateTime(tr, v.pushedAt)];
    if (v.available && v.messageChanged && sum?.kind !== 'message-only') {
        second.push(tr.t('timeline.tipMessageChanged'));
    }
    if (v.index === opts.n) {
        second.push(tr.t('timeline.latest'));
    }
    if (v.index === opts.lastReviewed) {
        second.push(tr.t('timeline.reviewedByYou'));
    }
    return `${first.join(' · ')}\n${second.join(' · ')}`;
}
