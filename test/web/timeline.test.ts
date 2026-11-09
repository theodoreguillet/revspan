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

    it('colonnes par jour, écarts ≥ 2 jours, marque « relu » après v7', () => {
        const items = timelineModel(fr, base);
        expect(days(items).map((d) => d.label)).toEqual(['14 oct.', '29 oct.', '2 nov.', '3 nov.', '5 nov. · aujourd\'hui']);
        expect(items.flatMap((it) => (it.type === 'gap' ? [it.label] : []))).toEqual(['15 j', '4 j', '2 j']);
        const seen = items.findIndex((it) => it.type === 'seen');
        expect(items[seen]).toEqual({ type: 'seen', after: 7 });
        expect(items[seen + 1]).toMatchObject({ type: 'gap', label: '2 j', after: 7 });
        expect(visibleNodes(items)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('masquer rebases seuls et deps : garde les bornes, la plage et la version relue', () => {
        const items = timelineModel(fr, { ...base, hideNoCode: true });
        // v2, v3 (deps), v5, v6 (rebase seul) masqués ; v7 (relue, borne) et v8-v9 (dans la plage) gardés
        expect(visibleNodes(items)).toEqual([1, 4, 7, 8, 9, 10]);
        const hidden = days(items).flatMap((d) => d.nodes.filter((node) => node.type === 'hidden'));
        expect(hidden).toEqual([{ type: 'hidden', list: [2, 3] }, { type: 'hidden', list: [5] }, { type: 'hidden', list: [6] }]);
    });

    it('un découpage « relu » au milieu d\'un jour garde le même jour sans répéter son libellé', () => {
        const items = timelineModel(fr, { ...base, lastReviewed: 2, from: 2 });
        expect(days(items).map((d) => d.label)).toEqual(['14 oct.', '29 oct.', '', '2 nov.', '3 nov.', '5 nov. · aujourd\'hui']);
    });

    it('bande de la plage : éléments intermédiaires entre from (inclus) et to (exclu)', () => {
        expect(inBand(7, 7, 10)).toBe(true);
        expect(inBand(9, 7, 10)).toBe(true);
        expect(inBand(10, 7, 10)).toBe(false);
        expect(inBand(6, 7, 10)).toBe(false);
    });
});

describe('repli automatique des longues PR', () => {
    // 34 versions (une tous les 4 jours depuis le 1er juin), rebases en v7, v14, v21, v28, relue en v30
    const versions = makeVersions(34, { rebases: [7, 14, 21, 28], stepDays: 4 });
    const sums = makeSums(['creation', ...Array<'code'>(33).fill('code')]);
    const input = { versions, sums, lastReviewed: 30, from: 30, to: 34, hideNoCode: false, foldDisabled: false };

    it('au plus 12 versions visibles : les plus anciennes sont repliées en un bloc', () => {
        const items = timelineModel(fr, input);
        expect(items.filter((it) => it.type === 'fold')).toEqual([{ type: 'fold', a: 1, b: 22, months: 'juin → août', codeCount: 22, rebases: 3 }]);
        expect(visibleNodes(items)).toEqual(Array.from({ length: 12 }, (_, k) => 23 + k));
    });

    it('jamais replié : après ma relecture, les bornes, l\'intérieur de la plage, la dernière version', () => {
        const states = nodeStates({ ...input, from: 5, to: 20 });
        const shown = (lo: number, hi: number): boolean =>
            states.filter((s) => s.version.index >= lo && s.version.index <= hi).every((s) => s.state === 'shown');
        expect(shown(5, 20)).toBe(true);
        expect(shown(30, 34)).toBe(true);
        expect(states.some((s) => s.state === 'folded')).toBe(true);
    });

    it('« vN complète » (from = 0) : l\'intérieur de la plage peut être replié', () => {
        const items = timelineModel(fr, { ...input, from: 0, to: 34, lastReviewed: null });
        expect(items.find((it) => it.type === 'fold')).toMatchObject({ a: 1, b: 22 });
    });

    it('résumé absent : nombre de versions de code inconnu', () => {
        expect(timelineModel(fr, { ...input, sums: new Map() }).find((it) => it.type === 'fold')).toMatchObject({ codeCount: null });
    });

    it('déplié par l\'utilisateur : plus aucun repli', () => {
        expect(timelineModel(fr, { ...input, foldDisabled: true }).some((it) => it.type === 'fold')).toBe(false);
    });

    it('un repli d\'une seule version est annulé', () => {
        const short = makeVersions(14);
        const states = nodeStates({ versions: short, sums: makeSums(Array(14).fill('code')), lastReviewed: 2, from: 2, to: 14, hideNoCode: false, foldDisabled: false, maxVisible: 12 });
        expect(states.every((s) => s.state === 'shown')).toBe(true);
    });
});

describe('nodeDelta / nodeTooltip', () => {
    const { data, sums } = prLong();

    it('code : +a −r ; sinon le type ; « … » en attendant le résumé', () => {
        expect(nodeDelta(fr, sums.get(4))).toEqual({ code: true, added: 35, removed: 14 });
        expect(nodeDelta(fr, sums.get(1))).toEqual({ code: false, text: 'création' });
        expect(nodeDelta(fr, sums.get(5))).toEqual({ code: false, text: 'rebase seul' });
        expect(nodeDelta(fr, sums.get(9))).toEqual({ code: false, text: 'deps' });
        expect(nodeDelta(fr, undefined)).toEqual({ code: false, text: '…' });
    });

    it('infobulle : version, date, hash, base ou rebase, type, fichiers', () => {
        const opts = { lastReviewed: 7, n: 10 };
        expect(nodeTooltip(fr, versionAt(data.versions, 8), sums.get(8), opts))
            .toMatch(/^v8 · \d\d\/11 \d\d:\d\d · e437672 · rebase sur 070b8d3 \(137 fichiers de master\) · rebase seul$/);
        expect(nodeTooltip(fr, versionAt(data.versions, 4), sums.get(4), opts))
            .toContain('code · UpdateRecord.ts, UpdateRecordSpec.ts, coverage.config.json et openapi.yaml · +35 −14');
        expect(nodeTooltip(fr, versionAt(data.versions, 7), sums.get(7), opts)).toContain('relue par toi');
        expect(nodeTooltip(fr, versionAt(data.versions, 10), sums.get(10), opts)).toMatch(/dernière version$/);
    });

    it('version indisponible : explication à la place de la base et du type ; référence ancienne signalée', () => {
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
