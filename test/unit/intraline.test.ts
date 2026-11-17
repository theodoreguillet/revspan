import { describe, expect, it } from 'vitest';
import type { DiffLine } from '../../src/shared/api.ts';
import { highlightIntraLine, WORK_BUDGET, workBudget } from '../../src/server/core/intraline.ts';

/** A "-" run (old lines 1, 2…) followed by a "+" run (new lines 1, 2…). */
function run(removed: readonly string[], added: readonly string[]): { del: DiffLine[]; add: DiffLine[] } {
    const del = removed.map((text, k): DiffLine => ({ t: '-', o: k + 1, n: null, text, hl: [] }));
    const add = added.map((text, k): DiffLine => ({ t: '+', o: null, n: k + 1, text, hl: [] }));
    return { del, add };
}

describe('highlightIntraLine', () => {
    /** Runs the highlighting on a "-" run followed by a "+" run. */
    function highlight(removed: readonly string[], added: readonly string[]): { del: DiffLine[]; add: DiffLine[] } {
        const lines = run(removed, added);
        highlightIntraLine([...lines.del, ...lines.add]);
        return lines;
    }
    const marked = (l: DiffLine): string[] => l.hl.map(([start, end]) => l.text.slice(start, end));

    it('marks only the changed words, in several ranges', () => {
        const { del, add } = highlight(['const ok = validateData(this.payload);'], ['const ok = validatePayloadData(this.payload, options);']);
        expect(add[0]!.hl).toEqual([[19, 26], [43, 52]]);
        expect(marked(add[0]!)).toEqual(['Payload', ', options']);
        expect(del[0]!.hl).toEqual([]);
    });

    it('a replaced word is marked whole, a part of it only at a camelCase, snake_case or digit boundary', () => {
        const flag = highlight(['const enabled = true;'], ['const enabled = false;']);
        expect(flag.del[0]!.hl).toEqual([[16, 20]]);
        expect(flag.add[0]!.hl).toEqual([[16, 21]]);
        const getter = highlight(['const label = user.getName() + user_id + item10;'], ['const label = user.getTitle() + user_name + item11;']);
        expect(marked(getter.del[0]!)).toEqual(['Name', 'id', '10']);
        expect(marked(getter.add[0]!)).toEqual(['Title', 'name', '11']);
    });

    it('joins two changed words separated by a space only', () => {
        const { del, add } = highlight(['    await this.store.save(left + right, id);'], ['    await this.store.save(top - bottom, id);']);
        expect(marked(del[0]!)).toEqual(['left + right']);
        expect(marked(add[0]!)).toEqual(['top - bottom']);
        const apart = highlight(['const sum = add(first, second);'], ['const sum = add(one, two);']);
        expect(marked(apart.del[0]!)).toEqual(['first', 'second']);
        expect(marked(apart.add[0]!)).toEqual(['one', 'two']);
    });

    it('pairs a removed line with the most similar added line of the run, the others stay unmarked', () => {
        const { del, add } = highlight(
            ['    const user = await this.users.findById(userId, { withRoles: true });'],
            ['    const options = { withRoles: true };', '    const user = await this.users.findById(userId, options);'],
        );
        expect(marked(del[0]!)).toEqual(['{ withRoles: true }']);
        expect(add[0]!.hl).toEqual([]);
        expect(marked(add[1]!)).toEqual(['options']);
        // the side-by-side view puts the pair on one row
        expect(del[0]!.pair).toBe(2);
    });

    it('never crosses two pairings: the most similar pair wins', () => {
        const { del, add } = highlight(
            ['const first = load(alpha, 1);', 'const second = load(beta, 2);'],
            ['const second = load(beta, 2, true);', 'const first = load(alpha, 10);'],
        );
        expect(marked(del[0]!)).toEqual(['1']);
        expect(marked(add[1]!)).toEqual(['10']);
        expect(del[1]!.hl).toEqual([]);
        expect(add[0]!.hl).toEqual([]);
        expect(del.map((l) => l.pair)).toEqual([2, undefined]);
    });

    it('marks a single inserted (or removed) block however small the line', () => {
        const { del, add } = highlight(['    foo();', '    }', '    bar(a, b, c, d);'], ['    foo(alpha, beta, gamma);', '    } // checked', '    bar();']);
        expect(marked(add[0]!)).toEqual(['alpha, beta, gamma']);
        expect(add[1]!.hl).toEqual([[5, 16]]);
        expect(marked(add[1]!)).toEqual([' // checked']);
        expect(marked(del[2]!)).toEqual(['a, b, c, d']);
        expect([del[0]!.hl, del[1]!.hl, add[2]!.hl]).toEqual([[], [], []]);
        expect(del.map((l) => l.pair)).toEqual([1, 2, 3]);
        expect(marked(highlight(['foo()'], ['foo(a, b, c, d)']).add[0]!)).toEqual(['a, b, c, d']);
        // a line without a word: the block added at its end, the indentation aside (re-indented here)
        expect(marked(highlight(['    }'], ['    }, { once: true });']).add[0]!)).toEqual([', { once: true });']);
        expect(marked(highlight(['    }'], ['        }, { once: true });']).add[0]!)).toEqual(['    ', ', { once: true });']);
    });

    it('pairs a short line with the added line that is the same plus one inserted block', () => {
        const { del, add } = highlight(['    }'], ['    const total = sum(values);', '    } // checked']);
        expect(del[0]!.pair).toBe(2);
        expect(marked(add[1]!)).toEqual([' // checked']);
        expect(add[0]!.hl).toEqual([]);
    });

    it('a bracket line is not an insertion into any line that holds the bracket: no pairing, no band', () => {
        const total = highlight(['        });', '    }'], ['        const total = items.reduce((sum, item) => sum + item.price, 0);', '        return { total };']);
        const brace = highlight(['{'], ['    const x = { y: 1 };']);
        const call = highlight(['    });'], ['    foo({ a: 1 });']);
        for (const { del, add } of [total, brace, call]) {
            expect([...del, ...add].map((l) => l.hl)).toEqual([...del, ...add].map(() => []));
            expect(del.map((l) => l.pair)).toEqual(del.map(() => undefined));
        }
    });

    it('a short line does not take the partner of a similar line', () => {
        const { del, add } = highlight(['    }', '    const value = buildRecord(source, target, mode);'], ['    const { value } = buildEntry(source, mapping);']);
        expect(del.map((l) => l.pair)).toEqual([undefined, 1]);
        expect(del[0]!.hl).toEqual([]);
        expect(marked(del[1]!)).toEqual(['Record', 'target, mode']);
        expect(marked(add[0]!)).toEqual(['{ ', ' }', 'Entry', 'mapping']);
    });

    it('two separate insertions are not one block: the 40 % rule decides', () => {
        // a(b) → a(x, b, y): half of the longer line is common, so it is marked
        expect(marked(highlight(['a(b)'], ['a(x, b, y)']).add[0]!)).toEqual(['x, ', ', y']);
        // call(b) → wrap(x, call(b), y): too little in common
        const wrapped = highlight(['    call(b);'], ['    wrap(first, call(b), second);']);
        expect([wrapped.del[0]!.hl, wrapped.add[0]!.hl]).toEqual([[], []]);
    });

    it('no highlight when the lines are too different (the line background says it all)', () => {
        const { del, add } = highlight(['        return a.b(c);', 'const id = recordData.labels?.slug;'], ['        throw new Error(x.y);', 'const id = this.repo.buildIdFromPayload(recordData);']);
        expect([...del, ...add].map((l) => l.hl)).toEqual([[], [], [], []]);
    });

    it('marks an indentation or trailing space change', () => {
        const { del, add } = highlight(['    run();', 'stop();  '], ['        run();', 'stop();']);
        expect(add[0]!.hl).toEqual([[4, 8]]);
        expect(del[0]!.hl).toEqual([]);
        expect(del[1]!.hl).toEqual([[7, 9]]);
        expect(add[1]!.hl).toEqual([]);
    });

    it('long lines fall back to one range between the common prefix and suffix', () => {
        const filler = 'v'.repeat(1000);
        const long = highlight([`${filler} foo bar baz`], [`${filler} qux bar quux`]);
        expect(long.del[0]!.hl).toEqual([[1001, 1012]]);
        expect(long.add[0]!.hl).toEqual([[1001, 1013]]);
        // Short enough, but too many tokens to compare word by word.
        const dense = highlight([`${'p'.repeat(60)} ${'a,'.repeat(101)}X`], [`${'p'.repeat(60)} ${'a;'.repeat(101)}Y`]);
        expect(dense.del[0]!.hl).toEqual([[62, 264]]);
        expect(dense.add[0]!.hl).toEqual([[62, 264]]);
        const huge = highlight([`${'w'.repeat(2001)}a`], [`${'w'.repeat(2001)}b`]);
        expect(huge.del[0]!.hl).toEqual([]);
        expect(huge.add[0]!.hl).toEqual([]);
    });

    it('stays fast on a long run of changed lines', () => {
        const removed = Array.from({ length: 400 }, (_, i) => `    const value${i} = compute(input, ${i}, 'label ${i}');`);
        const added = removed.map((text) => text.replace('compute(input', 'computeAll(input, options'));
        const start = Date.now();
        const { del, add } = highlight(removed, added);
        expect(Date.now() - start).toBeLessThan(1000);
        expect(marked(del[399]!)).toEqual([]);
        expect(marked(add[399]!)).toEqual(['All', ', options']);
    });

    it('keeps to the work budget of the file on a long run of dense lines, then falls back to the common prefix and suffix', () => {
        // ~200 tokens per line, the words of the middle moved: each pair needs a full comparison in order (~36 000 cells).
        const words = Array.from({ length: 95 }, (_, k) => `w${k}`);
        const removed = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(57)} ${words.join(' ')} ${'y'.repeat(40)}`);
        const added = removed.map((text) => text.replace(`${words.join(' ')}`, `${words.slice(1).join(' ')} ${words[0]}`));
        const { del, add } = run(removed, added);
        const budget = workBudget();
        const start = Date.now();
        highlightIntraLine([...del, ...add], budget);
        expect(Date.now() - start).toBeLessThan(5000); // generous: the budget is the real bound
        expect(budget.spent).toBeLessThanOrEqual(WORK_BUDGET);
        expect(budget.spent).toBeGreaterThan(WORK_BUDGET - 50_000);
        // compared word by word while the budget lasts: the moved word only
        expect(marked(del[0]!)).toEqual(['w0 ']);
        expect(marked(add[0]!)).toEqual([' w0']);
        // then the prefix/suffix range of the old rule
        expect(del[299]!.hl).toEqual([[62, del[299]!.text.length - 41]]);
        expect(add[299]!.hl).toEqual([[62, add[299]!.text.length - 41]]);
        expect(del[299]!.pair).toBe(300);
    });

    it('checks a candidate pairing against the accepted ones by binary search, its cost counted in the budget', () => {
        // 4 999 alike removed lines whose best partner is taken by the last one: every candidate is checked and refused
        const removed = [...Array.from({ length: 4999 }, () => 'gamma x'), 'alpha beta'];
        const one = run(removed, ['alpha beta', 'gamma y']);
        const budget = workBudget();
        highlightIntraLine([...one.del, ...one.add], budget);
        expect(one.del[4999]!.pair).toBe(1);
        expect(one.del.slice(0, 4999).every((l) => l.pair === undefined)).toBe(true);
        // tokens 280 160 + bags 40 000 + 5 000 candidates × 16 steps (sort and search)
        expect(budget.spent).toBe(400_160);
        // forty such runs in one file stay within the budget, and quick
        const lines: DiffLine[] = [];
        for (let k = 0; k < 40; k++) {
            const block = run(removed, ['alpha beta', 'gamma y']);
            lines.push(...block.del, ...block.add, { t: ' ', o: null, n: null, text: '', hl: [] });
        }
        const file = workBudget();
        const start = Date.now();
        highlightIntraLine(lines, file);
        expect(file.spent).toBeLessThanOrEqual(WORK_BUDGET);
        expect(Date.now() - start).toBeLessThan(5000); // generous: was ~600 ms with a linear scan per candidate
    });

    it('checks a single insertion only for lines sharing a word, its cost counted in the budget, indentation aside', () => {
        const indent = ' '.repeat(1900);
        const index = (i: number): string => String(i).padStart(2, '0');
        const charsOf = (lines: { del: DiffLine[]; add: DiffLine[] }): number => [...lines.del, ...lines.add].reduce((sum, l) => sum + l.text.length, 0);
        // no word in common: no insertion check, only the tokens and the bags (one word per line) are paid
        const apart = run(Array.from({ length: 100 }, (_, i) => `${indent}foo${index(i)}`), Array.from({ length: 100 }, (_, i) => `${indent}bar${index(i)}`));
        const none = workBudget();
        highlightIntraLine([...apart.del, ...apart.add], none);
        expect(none.spent).toBe(charsOf(apart) * 8 + 100 * 100 + 100 * 100);
        expect(apart.del.every((l) => l.pair === undefined)).toBe(true);
        // `foo`, `(` and `)` in common but not similar: every pair is checked, each charged its shorter line without
        // the indentation (12 characters)
        const close = run(
            Array.from({ length: 100 }, (_, i) => `${indent}foo(alpha${index(i)})`),
            Array.from({ length: 100 }, (_, i) => `${indent}foo(beta${index(i)}, gamma${index(i)}, delta${index(i)})`),
        );
        const checked = workBudget();
        highlightIntraLine([...close.del, ...close.add], checked);
        // bags: 4 distinct tokens per removed line, 7 per added line
        expect(checked.spent).toBe(charsOf(close) * 8 + 100 * 400 + 100 * 700 + 100 * 100 * 12);
        expect(close.del.every((l) => l.pair === undefined)).toBe(true);
    });

    it('pairs a run of long similar lines by position when comparing every pair would cost more than the budget', () => {
        const words = (i: number, salt: string): string => Array.from({ length: 270 }, (_, k) => `${k === 135 ? salt : ''}t${i * 1000 + k}`).join(' ');
        const { del, add } = run(Array.from({ length: 100 }, (_, i) => words(i, 'x')), Array.from({ length: 100 }, (_, i) => words(i, 'y')));
        const budget = workBudget();
        const start = Date.now();
        highlightIntraLine([...del, ...add], budget);
        expect(Date.now() - start).toBeLessThan(5000);
        expect(budget.spent).toBeLessThanOrEqual(WORK_BUDGET);
        expect(del.map((l) => l.pair)).toEqual(add.map((l) => l.n));
        // over 1 000 characters: the prefix/suffix range
        const at = del[7]!.text.indexOf('xt');
        expect(del[7]!.hl).toEqual([[at, at + 1]]);
        expect(add[7]!.hl).toEqual([[at, at + 1]]);
    });
});
