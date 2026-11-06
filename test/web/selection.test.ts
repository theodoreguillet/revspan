import { describe, expect, it } from 'vitest';
import {
    clickSelection, defaultSelection, isValidSelection, parseRangeQuery, presets, readout, singleVersion,
} from '../../src/web/lib/selection.ts';
import { prLong } from './fixtures.ts';

describe('clickSelection', () => {
    it('clic simple : ce que la version a changé (N-1 → N)', () => {
        expect(clickSelection({ from: 7, to: 10 }, 4, false)).toEqual({ from: 3, to: 4 });
    });

    it('clic sur master : version « à » complète (from = 0, to inchangé)', () => {
        expect(clickSelection({ from: 3, to: 8 }, 0, false)).toEqual({ from: 0, to: 8 });
        expect(clickSelection({ from: 3, to: 8 }, 0, true)).toEqual({ from: 0, to: 8 });
    });

    it('Maj+clic au-delà de « à » : étend vers la droite', () => {
        expect(clickSelection({ from: 3, to: 8 }, 10, true)).toEqual({ from: 3, to: 10 });
    });

    it('Maj+clic avant ou sur « de » : étend vers la gauche (from = N-1)', () => {
        expect(clickSelection({ from: 3, to: 10 }, 2, true)).toEqual({ from: 1, to: 10 });
        expect(clickSelection({ from: 3, to: 10 }, 3, true)).toEqual({ from: 2, to: 10 });
    });

    it('Maj+clic dans la plage : déplace la borne la plus proche', () => {
        // 5 - 3 = 2 ≤ 10 - 5 = 5 → « de » plus proche
        expect(clickSelection({ from: 3, to: 10 }, 5, true)).toEqual({ from: 4, to: 10 });
        // 7 - 3 = 4 > 10 - 7 = 3 → « à » plus proche
        expect(clickSelection({ from: 3, to: 10 }, 7, true)).toEqual({ from: 3, to: 7 });
    });

    it('Maj+clic à égale distance : la borne « de » gagne', () => {
        expect(clickSelection({ from: 2, to: 8 }, 5, true)).toEqual({ from: 4, to: 8 });
    });
});

describe('defaultSelection', () => {
    it('relue avant la dernière version : depuis ma relecture', () => {
        expect(defaultSelection(10, 7)).toEqual({ from: 7, to: 10 });
    });

    it('à jour : dernière version seule', () => {
        expect(defaultSelection(10, 10)).toEqual({ from: 9, to: 10 });
    });

    it('jamais relue : tout contre master', () => {
        expect(defaultSelection(10, null)).toEqual({ from: 0, to: 10 });
    });

    it('une seule version : v1 complète', () => {
        expect(defaultSelection(1, null)).toEqual({ from: 0, to: 1 });
        expect(defaultSelection(1, 1)).toEqual({ from: 0, to: 1 });
    });
});

describe('isValidSelection / singleVersion / parseRangeQuery', () => {
    it('valide 0 ≤ from < to ≤ n', () => {
        expect(isValidSelection(10, 0, 10)).toBe(true);
        expect(isValidSelection(10, 7, 10)).toBe(true);
        expect(isValidSelection(10, 10, 10)).toBe(false);
        expect(isValidSelection(10, 3, 11)).toBe(false);
        expect(isValidSelection(10, -1, 4)).toBe(false);
        expect(isValidSelection(10, null, 4)).toBe(false);
    });

    it('version seule bornée à 1..n', () => {
        expect(singleVersion(10, 4)).toEqual({ from: 3, to: 4 });
        expect(singleVersion(10, 0)).toEqual({ from: 0, to: 1 });
        expect(singleVersion(10, 12)).toEqual({ from: 9, to: 10 });
    });

    it('lit from/to (chiffres seulement)', () => {
        expect(parseRangeQuery({ from: '7', to: '10' })).toEqual({ from: 7, to: 10 });
        expect(parseRangeQuery({ from: '-1', to: 'x' })).toEqual({ from: null, to: null });
        expect(parseRangeQuery({ from: ['7'] })).toEqual({ from: null, to: null });
    });
});

describe('presets', () => {
    it('« Depuis ma relecture » seulement si lastReviewed < n', () => {
        expect(presets(10, 7).map((p) => [p.key, p.from, p.to])).toEqual([['since', 7, 10], ['last', 9, 10], ['all', 0, 10]]);
        expect(presets(10, 10).map((p) => p.key)).toEqual(['last', 'all']);
        expect(presets(10, null).map((p) => p.key)).toEqual(['last', 'all']);
        expect(presets(1, null).map((p) => p.key)).toEqual(['all']);
    });
});

describe('readout', () => {
    const { data, sums } = prLong();
    const versions = data.versions;

    it('plage depuis ma relecture (#212, v7 → v10)', () => {
        expect(readout({ from: 7, to: 10, versions, sums, stats: null })).toEqual({
            bold: 'Changements de v8 à v10',
            rest: '· par rapport à v7 · code modifié en v10 · 1 rebase',
        });
    });

    it('plage avec plusieurs versions de code et rebases', () => {
        expect(readout({ from: 3, to: 10, versions, sums, stats: null }).rest).toBe('· par rapport à v3 · code modifié en v4, v10 · 3 rebases');
    });

    it('une seule version : sans code, ou avec rebase', () => {
        expect(readout({ from: 3, to: 4, versions, sums, stats: null })).toEqual({ bold: 'Changements de v4', rest: '· par rapport à v3' });
        expect(readout({ from: 7, to: 8, versions, sums, stats: null }).rest).toBe('· par rapport à v7 · aucun changement de code · 1 rebase');
    });

    it('plage sans code', () => {
        expect(readout({ from: 4, to: 9, versions, sums, stats: null }).rest).toBe('· par rapport à v4 · aucun changement de code · 3 rebases');
    });

    it('version complète contre master, avec les stats quand le diff est chargé', () => {
        expect(readout({ from: 0, to: 10, versions, sums, stats: null })).toEqual({ bold: 'v10 complète', rest: '· par rapport à sa base sur master' });
        expect(readout({ from: 0, to: 10, versions, sums, stats: { files: 10, added: 580, removed: 17 } }).rest)
            .toBe('· par rapport à sa base sur master · 10 fichiers, +580 −17');
    });

    it('résumé pas encore chargé : pas d\'affirmation sur le code', () => {
        expect(readout({ from: 7, to: 10, versions, sums: new Map(), stats: null }).rest).toBe('· par rapport à v7 · 1 rebase');
    });
});
