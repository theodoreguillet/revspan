import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inBand, nodeDelta, nodeStates, nodeTooltip, timelineModel, type TimelineItem } from '../../src/web/lib/timeline.ts';
import { makeSums, makeVersions, prLong, versionAt } from './fixtures.ts';
import { createTranslator } from '../../src/web/i18n/translator.ts';

// French, the language these expectations are written in (English is covered by test/web/i18n.test.ts and below).
const fr = createTranslator('fr');

type Day = Extract<TimelineItem, { type: 'day' }>;

const days = (items: TimelineItem[]): Day[] => items.filter((it): it is Day => it.type === 'day');
const visibleNodes = (items: TimelineItem[]): number[] =>
    days(items).flatMap((d) => d.nodes.flatMap((node) => (node.type === 'node' ? [node.version.index] : [])));

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T14:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('timelineModel (#212)', () => {
    const { data, sums } = prLong();
    const base = { versions: data.versions, sums, lastReviewed: 7, from: 7, to: 10, hideNoCode: false, foldDisabled: false };

    it('columns per day, gaps >= 2 days, "reviewed" mark after v7', () => {
        const items = timelineModel(fr, base);
        expect(days(items).map((d) => d.label)).toEqual(['14 oct.', '29 oct.', '2 nov.', '3 nov.', '5 nov. · aujourd\'hui']);
        expect(items.flatMap((it) => (it.type === 'gap' ? [it.label] : []))).toEqual(['15 j', '4 j', '2 j']);
        const seen = items.findIndex((it) => it.type === 'seen');
        expect(items[seen]).toEqual({ type: 'seen', after: 7 });
        expect(items[seen + 1]).toMatchObject({ type: 'gap', label: '2 j', after: 7 });
        expect(visibleNodes(items)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('hiding rebase-only and deps: keeps the bounds, the range and the reviewed version', () => {
        const items = timelineModel(fr, { ...base, hideNoCode: true });
        // v2, v3 (deps), v5, v6 (rebase only) hidden; v7 (reviewed, bound) and v8-v9 (in the range) kept
        expect(visibleNodes(items)).toEqual([1, 4, 7, 8, 9, 10]);
        const hidden = days(items).flatMap((d) => d.nodes.filter((node) => node.type === 'hidden'));
        expect(hidden).toEqual([{ type: 'hidden', list: [2, 3] }, { type: 'hidden', list: [5] }, { type: 'hidden', list: [6] }]);
    });

    it('a "reviewed" split in the middle of a day keeps the same day without repeating its label', () => {
        const items = timelineModel(fr, { ...base, lastReviewed: 2, from: 2 });
        expect(days(items).map((d) => d.label)).toEqual(['14 oct.', '29 oct.', '', '2 nov.', '3 nov.', '5 nov. · aujourd\'hui']);
    });

    it('range band: intermediate items between from (included) and to (excluded)', () => {
        expect(inBand(7, 7, 10)).toBe(true);
        expect(inBand(9, 7, 10)).toBe(true);
        expect(inBand(10, 7, 10)).toBe(false);
        expect(inBand(6, 7, 10)).toBe(false);
    });
});

describe('automatic folding of long PRs', () => {
    // 34 versions (one every 4 days since June 1), rebases at v7, v14, v21, v28, reviewed at v30
    const versions = makeVersions(34, { rebases: [7, 14, 21, 28], stepDays: 4 });
    const sums = makeSums(['creation', ...Array<'code'>(33).fill('code')]);
    const input = { versions, sums, lastReviewed: 30, from: 30, to: 34, hideNoCode: false, foldDisabled: false };

    it('at most 12 visible versions: the oldest are folded into one block', () => {
        const items = timelineModel(fr, input);
        expect(items.filter((it) => it.type === 'fold')).toEqual([{ type: 'fold', a: 1, b: 22, months: 'juin → août', codeCount: 22, rebases: 3 }]);
        expect(visibleNodes(items)).toEqual(Array.from({ length: 12 }, (_, k) => 23 + k));
    });

    it('never folded: after my review, the bounds, the inside of the range, the latest version', () => {
        const states = nodeStates({ ...input, from: 5, to: 20 });
        const shown = (lo: number, hi: number): boolean =>
            states.filter((s) => s.version.index >= lo && s.version.index <= hi).every((s) => s.state === 'shown');
        expect(shown(5, 20)).toBe(true);
        expect(shown(30, 34)).toBe(true);
        expect(states.some((s) => s.state === 'folded')).toBe(true);
    });

    it('"full vN" (from = 0): the inside of the range can be folded', () => {
        const items = timelineModel(fr, { ...input, from: 0, to: 34, lastReviewed: null });
        expect(items.find((it) => it.type === 'fold')).toMatchObject({ a: 1, b: 22 });
    });

    it('summary absent: number of code versions unknown', () => {
        expect(timelineModel(fr, { ...input, sums: new Map() }).find((it) => it.type === 'fold')).toMatchObject({ codeCount: null });
    });

    it('expanded by the user: no more folding', () => {
        expect(timelineModel(fr, { ...input, foldDisabled: true }).some((it) => it.type === 'fold')).toBe(false);
    });

    it('a single-version fold is cancelled', () => {
        const short = makeVersions(14);
        const states = nodeStates({ versions: short, sums: makeSums(Array(14).fill('code')), lastReviewed: 2, from: 2, to: 14, hideNoCode: false, foldDisabled: false, maxVisible: 12 });
        expect(states.every((s) => s.state === 'shown')).toBe(true);
    });
});

describe('nodeDelta / nodeTooltip', () => {
    const { data, sums } = prLong();

    it('code: +a -r; otherwise the type; "..." while waiting for the summary', () => {
        expect(nodeDelta(fr, sums.get(4))).toEqual({ code: true, added: 35, removed: 14 });
        expect(nodeDelta(fr, sums.get(1))).toEqual({ code: false, text: 'création' });
        expect(nodeDelta(fr, sums.get(5))).toEqual({ code: false, text: 'rebase seul' });
        expect(nodeDelta(fr, sums.get(9))).toEqual({ code: false, text: 'deps' });
        expect(nodeDelta(fr, undefined)).toEqual({ code: false, text: '…' });
    });

    it('tooltip: version, date, hash, base or rebase, type, files', () => {
        const opts = { lastReviewed: 7, n: 10 };
        expect(nodeTooltip(fr, versionAt(data.versions, 8), sums.get(8), opts))
            .toMatch(/^v8 · \d\d\/11 \d\d:\d\d · e437672 · rebase sur 070b8d3 \(137 fichiers de master\) · rebase seul$/);
        expect(nodeTooltip(fr, versionAt(data.versions, 4), sums.get(4), opts))
            .toContain('code · UpdateRecord.ts, UpdateRecordSpec.ts, coverage.config.json et openapi.yaml · +35 −14');
        expect(nodeTooltip(fr, versionAt(data.versions, 7), sums.get(7), opts)).toContain('relue par toi');
        expect(nodeTooltip(fr, versionAt(data.versions, 10), sums.get(10), opts)).toMatch(/dernière version$/);
    });

    it('unavailable version: explanation in place of the base and the type; old reference flagged', () => {
        const versions = makeVersions(3, { unavailable: [1] });
        const unavailable = nodeTooltip(fr, versionAt(versions, 1), { index: 1, kind: 'unavailable', added: 0, removed: 0, files: [], masterFiles: 0, conflicts: 0 }, { lastReviewed: 1, n: 3 });
        expect(unavailable).toContain('indisponible : Bitbucket a effacé ce commit');
        expect(unavailable).toContain('relue par toi');
        expect(unavailable).not.toContain('base');
        expect(nodeDelta(fr, { index: 1, kind: 'unavailable', added: 0, removed: 0, files: [], masterFiles: 0, conflicts: 0 })).toEqual({ code: false, text: 'indisponible' });
        const afterGap = nodeTooltip(fr, versionAt(versions, 2), { index: 2, kind: 'code', since: 0, added: 1, removed: 0, files: [], masterFiles: 0, conflicts: 0 }, { lastReviewed: 1, n: 3 });
        expect(afterGap).toContain('changements comptés depuis la base (versions précédentes indisponibles)');
    });
});
