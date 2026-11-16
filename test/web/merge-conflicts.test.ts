import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../src/web/i18n/translator.ts';
import { conflictChip, firstConflictIndex, isMergeConflict, rebaseChip } from '../../src/web/lib/merge-conflicts.ts';

const fr = createTranslator('fr');
const en = createTranslator('en');
const file = (path: string, oldPath: string | null = null): { path: string; oldPath: string | null } => ({ path, oldPath });

describe('rebase chip of the PR header', () => {
    it('shown for an open PR behind its destination, neutral wording, nothing when up to date or unknown', () => {
        expect(rebaseChip(fr, { state: 'OPEN', destBranch: 'master' }, true)).toEqual({
            label: 'À rebaser sur master',
            title: 'master a avancé depuis la base de la PR : la PR est à rebaser',
        });
        expect(rebaseChip(en, { state: 'OPEN', destBranch: 'develop' }, true)?.label).toBe('Needs rebase on develop');
        expect(rebaseChip(fr, { state: 'OPEN', destBranch: 'master' }, false)).toBeNull();
        expect(rebaseChip(fr, { state: 'OPEN', destBranch: 'master' }, null)).toBeNull();
        expect(rebaseChip(fr, { state: 'MERGED', destBranch: 'master' }, true)).toBeNull();
    });
});

describe('merge conflicts chip of the PR header', () => {
    const pr = { state: 'OPEN' as const, destBranch: 'master' };

    it('count of files, tooltip listing the paths; null when there is no conflict or it was not read', () => {
        const chip = conflictChip(fr, pr, ['src/a.ts', 'src/b.ts', 'README.md'], 1);
        expect(chip?.label).toBe('⚠ Conflits avec master · 3 fichiers');
        expect(chip?.title.split('\n')).toEqual([
            'Bitbucket signale des conflits de merge avec master dans :', 'src/a.ts', 'src/b.ts', 'README.md', 'Clic : ouvrir le premier fichier en conflit dans le diff',
        ]);
        expect(conflictChip(en, pr, ['a.ts'], -1)).toEqual({ label: '⚠ Conflict with master · 1 file', title: 'Bitbucket reports merge conflicts with master in:\na.ts' });
        expect(conflictChip(fr, pr, [], -1)).toBeNull();
        expect(conflictChip(fr, pr, null, -1)).toBeNull();
        expect(conflictChip(fr, { ...pr, state: 'DECLINED' }, ['a.ts'], 0)).toBeNull();
    });

    it('tooltip: at most 10 paths, then how many more', () => {
        const paths = Array.from({ length: 13 }, (_, i) => `f${i + 1}.ts`);
        const lines = conflictChip(fr, pr, paths, -1)?.title.split('\n') ?? [];
        expect(lines).toHaveLength(12);
        expect(lines[10]).toBe('f10.ts');
        expect(lines[11]).toBe('… et 3 autres');
    });
});

describe('conflicting files of the comparison', () => {
    const conflicts = new Set(['src/b.ts', 'old/name.ts']);

    it('a file conflicts by its path or, renamed, by its old path', () => {
        expect(isMergeConflict(file('src/b.ts'), conflicts)).toBe(true);
        expect(isMergeConflict(file('new/name.ts', 'old/name.ts'), conflicts)).toBe(true);
        expect(isMergeConflict(file('src/a.ts'), conflicts)).toBe(false);
    });

    it('first conflicting file of the shown comparison, -1 when none is shown', () => {
        expect(firstConflictIndex([file('src/a.ts'), file('src/b.ts')], conflicts)).toBe(1);
        expect(firstConflictIndex([file('src/a.ts')], conflicts)).toBe(-1);
        expect(firstConflictIndex([], conflicts)).toBe(-1);
    });
});
