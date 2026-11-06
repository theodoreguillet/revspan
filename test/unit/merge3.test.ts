import { describe, expect, it } from 'vitest';
import { merge3 } from '../../src/server/core/merge3.ts';

const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const edit = (index: number, value: string): string[] => base.map((l, i) => (i === index ? value : l));

describe('merge3', () => {
    it('changements disjoints : les deux côtés sont appliqués', () => {
        expect(merge3(base, edit(1, 'B'), edit(5, 'F'))).toEqual({ lines: ['a', 'B', 'c', 'd', 'e', 'F', 'g'], conflicts: 0 });
    });

    it('lignes voisines : pas de conflit', () => {
        expect(merge3(base, edit(1, 'B'), edit(2, 'C'))).toEqual({ lines: ['a', 'B', 'C', 'd', 'e', 'f', 'g'], conflicts: 0 });
    });

    it('même changement des deux côtés : pas de conflit', () => {
        expect(merge3(base, edit(2, 'X'), edit(2, 'X'))).toEqual({ lines: edit(2, 'X'), conflicts: 0 });
    });

    it('conflit : la version theirs gagne et le conflit est compté', () => {
        expect(merge3(base, edit(2, 'OURS'), edit(2, 'THEIRS'))).toEqual({ lines: edit(2, 'THEIRS'), conflicts: 1 });
    });

    it('insertions différentes au même endroit : conflit', () => {
        const theirs = ['a', 'b', 'y1', 'c', 'd', 'e', 'f', 'g'];
        expect(merge3(base, ['a', 'b', 'x1', 'c', 'd', 'e', 'f', 'g'], theirs)).toEqual({ lines: theirs, conflicts: 1 });
    });

    it('insertion d\'un côté, suppression de l\'autre ailleurs', () => {
        expect(merge3(base, [...base, 'h'], base.slice(1))).toEqual({ lines: ['b', 'c', 'd', 'e', 'f', 'g', 'h'], conflicts: 0 });
    });

    it('lockfile : master et l\'auteur montent des libs, la ligne commune garde la RC de l\'auteur', () => {
        const lockBase = ['"a": "1.0.0",', '"b": "1.0.0",', '"c": "1.0.0",', '"d": "1.0.0",', '"e": "1.0.0",'];
        const master = ['"a": "1.1.0",', '"b": "1.0.0",', '"c": "1.0.0",', '"d": "1.0.0",', '"e": "2.0.0",'];
        const author = ['"a": "1.0.0",', '"b": "1.0.0",', '"c": "1.0.0-rc.1",', '"d": "1.0.0",', '"e": "2.0.0-rc.1",'];
        expect(merge3(lockBase, master, author)).toEqual({
            lines: ['"a": "1.1.0",', '"b": "1.0.0",', '"c": "1.0.0-rc.1",', '"d": "1.0.0",', '"e": "2.0.0-rc.1",'],
            conflicts: 1,
        });
    });

    it('très gros fichiers divergents : pas de dépassement de pile', () => {
        const big = Array.from({ length: 250000 }, (_, i) => `l${i}`);
        const result = merge3(big, big.map((l) => `${l}-o`), big.slice());
        expect(result.lines).toHaveLength(250000);
        expect(result.lines[0]).toBe('l0-o');
    });
});
