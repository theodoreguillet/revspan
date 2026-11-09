import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bannerModel } from '../../src/web/lib/banner.ts';
import { segText } from '../../src/web/lib/segments.ts';
import { loadPr, makeSums, makeVersions, prLong } from './fixtures.ts';
import { createTranslator } from '../../src/web/i18n/translator.ts';

// French, the language these expectations are written in (English is covered by test/web/i18n.test.ts and below).
const fr = createTranslator('fr');

const lines = (model: ReturnType<typeof bannerModel>): string[] => model.lines.map(segText);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T14:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('bannerModel in English', () => {
    const en = createTranslator('en');

    it('since my review: English word order and punctuation, bold and monospace parts kept', () => {
        const { data, sums } = prLong();
        const model = bannerModel(en, data, sums, true);
        expect(model.head).toBe('Since your review of v7 (Nov 3): 3 versions, 1 of which touches code');
        expect(lines(model)).toEqual([
            'v10: CreateRecord.ts and coverage.config.json, +2 −2',
            'v9: package-lock.json only · v8: rebased onto master, nothing from the author (137 master files hidden)',
            '+ 1 new thread and 1 new reply (Yann and Camille)',
        ]);
        expect(model.lines[0]?.slice(0, 4)).toEqual([{ text: 'v10', kind: 'b' }, ': ', { text: 'CreateRecord.ts', kind: 'mono' }, ' and ']);
    });

    it('only rebases since my approval', () => {
        const { data, sums } = loadPr('rebase');
        const model = bannerModel(en, data, sums, true);
        expect(model.head).toBe('Since your review of v9: only rebases, no changes from the author');
        expect(lines(model)).toEqual(['Nothing to review · 41 master files hidden · no new comments', 'Your approval of v9 still stands on Bitbucket']);
    });
});

describe('bannerModel', () => {
    it('since my review (#212, v7): versions, code, rebase, new comments', () => {
        const { data, sums } = prLong();
        const model = bannerModel(fr, data, sums, true);
        expect(model.variant).toBe('since');
        expect(model.head).toBe('Depuis ta relecture de v7 (3 nov.) : 3 versions, dont 1 touche du code');
        expect(lines(model)).toEqual([
            'v10 : CreateRecord.ts et coverage.config.json, +2 −2',
            'v9 : package-lock.json seulement · v8 : rebase sur master, rien de l\'auteur (137 fichiers de master masqués)',
            '+ 1 nouveau fil et 1 nouvelle réponse (Yann et Camille)',
        ]);
        expect(model).toMatchObject({ action: 'mark', rule: true, latest: 10 });
    });

    it('summary being loaded', () => {
        const { data } = prLong();
        const model = bannerModel(fr, data, new Map(), false);
        expect(model.variant).toBe('loading');
        expect(model.head).toBe('Depuis ta relecture de v7 (3 nov.) : 3 versions');
        expect(lines(model)[0]).toBe('Analyse des versions…');
    });

    it('up to date: no button', () => {
        const { data, sums } = prLong();
        const model = bannerModel(fr, { ...data, review: { ...data.review, lastReviewed: 10 } }, sums, true);
        expect(model).toMatchObject({ variant: 'up-to-date', head: 'Tu es à jour : v10 relue (3 nov.)', action: 'none' });
    });

    it('first review', () => {
        const { data, sums } = prLong();
        const model = bannerModel(fr, { ...data, review: { ...data.review, lastReviewed: null, lastReviewedAt: null } }, sums, true);
        expect(model.variant).toBe('first');
        expect(model.head).toBe('Première relecture : 10 versions depuis le 14 oct.');
        expect(lines(model)[0]).toBe('3 versions avec du code, 4 rebases · « Tout vs master » montre la PR complète');
        expect(model.action).toBe('mark');
    });

    it('only rebases since my approval, still active on Bitbucket: nothing to re-approve', () => {
        const { data, sums } = loadPr('rebase');
        const model = bannerModel(fr, data, sums, true);
        expect(model).toMatchObject({ variant: 'fast', action: 'mark', rule: false });
        expect(model.head).toBe('Depuis ta relecture de v9 : seulement des rebases, aucun changement de l\'auteur');
        expect(lines(model)).toEqual(['Rien à relire · 41 fichiers de master masqués · aucun nouveau commentaire', 'Ton approbation de v9 reste valable sur Bitbucket']);
    });

    it('approval removed by Bitbucket on push: quick re-approval (except on my PR)', () => {
        const { data, sums } = loadPr('rebase');
        const reset = {
            ...data,
            participants: data.participants.map((p) => (p.user?.uuid === data.me?.uuid ? { ...p, approved: false, state: null } : p)),
        };
        const model = bannerModel(fr, reset, sums, true);
        expect(model.action).toBe('reapprove');
        expect(lines(model)).toEqual(['Rien à relire · 41 fichiers de master masqués · aucun nouveau commentaire']);
        expect(bannerModel(fr, { ...reset, pr: { ...reset.pr, author: reset.me } }, sums, true).action).toBe('mark');
    });

    it('many versions without code: a summary line', () => {
        const { data } = prLong();
        const versions = makeVersions(9, { rebases: [3, 5, 7] });
        const sums = makeSums(['creation', 'rebase-only', 'rebase-only', 'deps', 'rebase-only', 'none', 'deps', 'code', 'rebase-only']);
        const model = bannerModel(fr, { ...data, versions, threads: [], review: { ...data.review, lastReviewed: 1, lastReviewedAt: null } }, sums, true);
        expect(model.head).toBe('Depuis ta relecture de v1 : 8 versions, dont 1 touche du code');
        expect(lines(model)).toEqual([
            'v8 : F8.ts, +10 −2',
            '7 versions sans code : 4 rebases seuls (20 fichiers de master masqués), 2 versions de dépendances, 1 autre sans changement de l\'auteur',
        ]);
    });

    it('commit message changed and single version without code', () => {
        const { data } = prLong();
        const versions = makeVersions(3, { messageChanged: [3] });
        const sums = makeSums(['creation', 'code', 'deps']);
        const model = bannerModel(fr, { ...data, versions, threads: [], review: { ...data.review, lastReviewed: 2, lastReviewedAt: null } }, sums, true);
        expect(model.head).toBe('Depuis ta relecture de v2 : 1 version, sans code');
        expect(lines(model)).toEqual(['v3 : package-lock.json seulement', 'message du commit modifié']);
    });

    describe('new version pushed while reading, absent from the loaded summary: shown without detail', () => {
        const { data } = prLong();
        const reviewedAt = (lastReviewed: number) => ({ ...data.review, lastReviewed, lastReviewedAt: null });

        it('with other versions: "..." line, the code count only says what we know', () => {
            const versions = makeVersions(4, { rebases: [4] });
            const model = bannerModel(fr, { ...data, versions, threads: [], review: reviewedAt(1) }, makeSums(['creation', 'code', 'deps']), true);
            expect(model).toMatchObject({ variant: 'since', head: 'Depuis ta relecture de v1 : 3 versions, dont 1 touche du code', action: 'mark' });
            expect(lines(model)).toEqual(['v4 : … · rebase sur master', 'v2 : F2.ts, +10 −2', 'v3 : package-lock.json seulement']);
        });

        it('alone: neither "without code" nor "nothing to review"', () => {
            const versions = makeVersions(3);
            const model = bannerModel(fr, { ...data, versions, threads: [], review: reviewedAt(2) }, makeSums(['creation', 'rebase-only']), true);
            expect(model).toMatchObject({ variant: 'since', head: 'Depuis ta relecture de v2 : 1 version' });
            expect(lines(model)).toEqual(['v3 : …']);
        });

        it('after many versions without code: not counted as "no author change"', () => {
            const versions = makeVersions(8);
            const sums = makeSums(['creation', 'rebase-only', 'rebase-only', 'deps', 'rebase-only', 'none', 'deps']);
            const model = bannerModel(fr, { ...data, versions, threads: [], review: reviewedAt(1) }, sums, true);
            expect(model.head).toBe('Depuis ta relecture de v1 : 7 versions');
            expect(lines(model)).toEqual([
                'v8 : …',
                '6 versions sans code : 3 rebases seuls (15 fichiers de master masqués), 2 versions de dépendances, 1 autre sans changement de l\'auteur',
            ]);
        });
    });
});
