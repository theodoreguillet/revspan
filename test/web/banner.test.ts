import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bannerModel } from '../../src/web/lib/banner.ts';
import { segText } from '../../src/web/lib/segments.ts';
import { loadPr, makeSums, makeVersions, prLong } from './fixtures.ts';

const lines = (model: ReturnType<typeof bannerModel>): string[] => model.lines.map(segText);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T14:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('bannerModel', () => {
    it('depuis ma relecture (#212, v7) : versions, code, rebase, nouveaux commentaires', () => {
        const { data, sums } = prLong();
        const model = bannerModel(data, sums, true);
        expect(model.variant).toBe('since');
        expect(model.head).toBe('Depuis ta relecture de v7 (3 nov.) : 3 versions, dont 1 touche du code');
        expect(lines(model)).toEqual([
            'v10 : CreateRecord.ts et coverage.config.json, +2 −2',
            'v9 : package-lock.json seulement · v8 : rebase sur master, rien de l\'auteur (137 fichiers de master masqués)',
            '+ 1 nouveau fil et 1 nouvelle réponse (Yann et Camille)',
        ]);
        expect(model).toMatchObject({ action: 'mark', rule: true, latest: 10 });
    });

    it('résumé en cours de chargement', () => {
        const { data } = prLong();
        const model = bannerModel(data, new Map(), false);
        expect(model.variant).toBe('loading');
        expect(model.head).toBe('Depuis ta relecture de v7 (3 nov.) : 3 versions');
        expect(lines(model)[0]).toBe('Analyse des versions…');
    });

    it('à jour : pas de bouton', () => {
        const { data, sums } = prLong();
        const model = bannerModel({ ...data, review: { ...data.review, lastReviewed: 10 } }, sums, true);
        expect(model).toMatchObject({ variant: 'up-to-date', head: 'Tu es à jour : v10 relue (3 nov.)', action: 'none' });
    });

    it('première relecture', () => {
        const { data, sums } = prLong();
        const model = bannerModel({ ...data, review: { ...data.review, lastReviewed: null, lastReviewedAt: null } }, sums, true);
        expect(model.variant).toBe('first');
        expect(model.head).toBe('Première relecture : 10 versions depuis le 14 oct.');
        expect(lines(model)[0]).toBe('3 versions avec du code, 4 rebases · « Tout vs master » montre la PR complète');
        expect(model.action).toBe('mark');
    });

    it('seulement des rebases depuis ma relecture : réapprobation rapide', () => {
        const { data, sums } = loadPr('rebase');
        const model = bannerModel(data, sums, true);
        expect(model).toMatchObject({ variant: 'fast', action: 'reapprove', rule: false });
        expect(model.head).toBe('Depuis ta relecture de v9 : seulement des rebases, aucun changement de l\'auteur');
        expect(lines(model)).toEqual(['Rien à relire · 41 fichiers de master masqués · aucun nouveau commentaire']);
    });

    it('réapprobation rapide impossible sur ma PR ou si la dernière version est déjà approuvée', () => {
        const { data, sums } = loadPr('rebase');
        const mine = bannerModel({ ...data, pr: { ...data.pr, author: data.me } }, sums, true);
        expect(mine.action).toBe('mark');
        const approved = bannerModel({
            ...data,
            participants: data.participants.map((p) => (p.user?.uuid === data.me?.uuid ? { ...p, approvedVersion: 10 } : p)),
        }, sums, true);
        expect(approved.action).toBe('mark');
    });

    it('beaucoup de versions sans code : une ligne de synthèse', () => {
        const { data } = prLong();
        const versions = makeVersions(9, { rebases: [3, 5, 7] });
        const sums = makeSums(['creation', 'rebase-only', 'rebase-only', 'deps', 'rebase-only', 'none', 'deps', 'code', 'rebase-only']);
        const model = bannerModel({ ...data, versions, threads: [], review: { ...data.review, lastReviewed: 1, lastReviewedAt: null } }, sums, true);
        expect(model.head).toBe('Depuis ta relecture de v1 : 8 versions, dont 1 touche du code');
        expect(lines(model)).toEqual([
            'v8 : F8.ts, +10 −2',
            '7 versions sans code : 4 rebases seuls (20 fichiers de master masqués), 2 versions de dépendances, 1 autre sans changement de l\'auteur',
        ]);
    });

    it('message du commit modifié et version unique sans code', () => {
        const { data } = prLong();
        const versions = makeVersions(3, { messageChanged: [3] });
        const sums = makeSums(['creation', 'code', 'deps']);
        const model = bannerModel({ ...data, versions, threads: [], review: { ...data.review, lastReviewed: 2, lastReviewedAt: null } }, sums, true);
        expect(model.head).toBe('Depuis ta relecture de v2 : 1 version, sans code');
        expect(lines(model)).toEqual(['v3 : package-lock.json seulement', 'message du commit modifié']);
    });
});
