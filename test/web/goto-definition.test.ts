import { describe, expect, it } from 'vitest';
import type { DiffLine, FileDiff, Hunk } from '../../src/shared/api.ts';
import {
    definesSymbol, familyOf, findDefinitions, findImport, findLine, gotoDefinition, identifierAt, resolveImport, tokenClass,
    type CodeFamily, type LineRef,
} from '../../src/web/lib/goto-definition.ts';

/** A hunk from [sign, text] rows, numbered from 1 on both sides like a real diff. */
function hunk(rows: readonly (readonly [DiffLine['t'], string])[]): Hunk {
    let o = 1;
    let n = 1;
    const lines = rows.map(([t, text]): DiffLine => ({
        t, text, hl: [], o: t === '+' ? null : o++, n: t === '-' ? null : n++,
    }));
    return { oldStart: 1, oldLines: o - 1, newStart: 1, newLines: n - 1, header: '', lines };
}

const file = (path: string, ...hunks: Hunk[]): FileDiff => ({
    path, oldPath: null, status: 'modified', category: 'code', binary: false, tooLarge: false,
    added: 0, removed: 0, contentHash: 'h', conflict: false, hunks, threads: [],
});

const ctx = (...texts: string[]) => texts.map((text) => [' ', text] as const);
const where = (refs: readonly LineRef[]): string[] => refs.map((ref) => `${ref.path}:${ref.side}:${ref.side === 'new' ? ref.line.n : ref.line.o}`);

describe('familyOf', () => {
    it('groups the languages by definition syntax; files of other languages have none', () => {
        expect(['a.ts', 'a.tsx', 'a.js', 'a.mjs', 'a.jsx', 'A.vue'].map(familyOf)).toEqual(['js', 'js', 'js', 'js', 'js', 'js']);
        expect(familyOf('tool.py')).toBe('python');
        expect(['A.java', 'a.kt', 'A.cs', 'a.go', 'a.rs', 'a.php', 'a.rb'].map(familyOf)).toEqual(Array(7).fill('other'));
        expect(['package.json', 'README.md', 'a.css', 'a.sh', 'Makefile', 'LICENSE'].map(familyOf)).toEqual(Array(6).fill(null));
    });
});

describe('identifierAt', () => {
    const text = '        return this.repo.save(id);';

    it('takes the identifier around the caret, whichever side of a character the pointer is on', () => {
        const start = text.indexOf('repo');
        for (const offset of [start, start + 2, start + 4]) {
            expect(identifierAt(text, offset, 'js')).toEqual({ name: 'repo', start, end: start + 4 });
        }
        // right after a dot: the identifier that follows
        expect(identifierAt(text, text.indexOf('save'), 'js')?.name).toBe('save');
    });

    it('accepts letters of any script, digits inside, _ and $', () => {
        expect(identifierAt('const café = 1;', 8, 'js')?.name).toBe('café');
        expect(identifierAt('this.$store_2.state', 7, 'js')?.name).toBe('$store_2');
    });

    it('nothing on punctuation, spaces, numbers, keywords or outside the line', () => {
        expect(identifierAt('a = (b);', 2, 'js')).toBeNull();
        expect(identifierAt('    x', 1, 'js')).toBeNull();
        expect(identifierAt('width = 42;', 9, 'js')).toBeNull();
        expect(identifierAt('margin: 1px', 9, 'js')).toBeNull();
        expect(identifierAt(text, text.indexOf('return') + 1, 'js')).toBeNull();
        expect(identifierAt(text, text.indexOf('this') + 1, 'js')).toBeNull();
        expect(identifierAt('def run(self):', 1, 'python')).toBeNull();
        expect(identifierAt('def run(self):', 5, 'python')?.name).toBe('run');
        expect(identifierAt('func (a *Action) Run() error {', 2, 'other')).toBeNull();
        expect(identifierAt('abc', 9, 'js')).toBeNull();
        expect(identifierAt('', 0, 'js')).toBeNull();
    });

    it('keywords depend on the language: `def` and `self` are names in TypeScript', () => {
        expect(identifierAt('const def = self;', 7, 'js')?.name).toBe('def');
        expect(identifierAt('const def = self;', 13, 'js')?.name).toBe('self');
    });
});

describe('tokenClass', () => {
    const families: CodeFamily[] = ['js', 'python', 'other'];

    it('a whole identifier token is a symbol (underlined with the modifier held)', () => {
        for (const family of families) {
            expect(tokenClass('repo', '#9CDCFE', family)).toBe('sym');
            expect(tokenClass('Action', '#267F99', family)).toBe('sym');
            expect(tokenClass('buildIdFromPayload', '#795e26', family)).toBe('sym');
        }
    });

    it('strings, comments, numbers and keywords of the Dark+ and Light+ themes are not symbols', () => {
        const colors = ['#CE9178', '#A31515', '#6A9955', '#008000', '#D16969', '#811F3F', '#B5CEA8', '#098658', '#569CD6', '#0000FF', '#C586C0', '#AF00DB'];
        for (const color of colors) {
            expect(tokenClass('word', color, 'js')).toBe('nosym');
        }
        expect(tokenClass('\'./Action\'', '#CE9178', 'js')).toBe('nosym');
        expect(tokenClass('// see Action', '#6a9955', 'js')).toBe('nosym');
    });

    it('a token holding more than an identifier, a keyword of the language, or no family: no class', () => {
        expect(tokenClass(' Foo(bar, ', '#D4D4D4', 'python')).toBeUndefined();
        expect(tokenClass('string', '#4EC9B0', 'js')).toBeUndefined();
        expect(tokenClass('self', '#9CDCFE', 'python')).toBeUndefined();
        expect(tokenClass('repo', '#9CDCFE', null)).toBeUndefined();
        expect(tokenClass('repo', undefined, 'js')).toBeUndefined();
    });
});

describe('definesSymbol: pattern table', () => {
    /** The lines, in a file at `path` (its extension gives the language), define / do not define `name`. */
    const yes = (path: string, name: string, lines: string[]) => {
        for (const text of lines) {
            expect(definesSymbol(text, name, path), `${path} should define ${name}: ${text}`).toBe(true);
        }
    };
    const no = (path: string, name: string, lines: string[]) => {
        for (const text of lines) {
            expect(definesSymbol(text, name, path), `${path} should not define ${name}: ${text}`).toBe(false);
        }
    };

    it('TypeScript / JavaScript / Vue: declarations', () => {
        yes('a.ts', 'Action', [
            'export class Action {', 'export default class Action extends Base {', 'abstract class Action<T> {',
            'export interface Action {', 'export type Action = { id: string };', 'const enum Action {', 'namespace Action {',
            'export const Action = defineComponent({',
        ]);
        yes('a.ts', 'run', [
            'export function run(data) {', 'export default async function run() {', 'function* run() {', 'function *run() {',
            'let run;', 'var run = {};', 'for (const run of runs) {',
        ]);
    });

    it('TypeScript / JavaScript / Vue: class members and object methods', () => {
        yes('a.ts', 'run', [
            '    run(data) {', '    async run(data: Data): Promise<void> {', '    private run(', '    static run<T>(x: T): T {',
            '    get run() {', '    private readonly run = new Map<string, number>();', '    protected run?: Handler;',
            '    run = (data) => {', '    run = async (data: Data): Promise<void> => {', '    run: (data) => data.id,',
            '    run: async function (data) {', '    run = data => data.id;', '    *run() {',
        ]);
    });

    it('TypeScript / JavaScript / Vue: uses, calls, imports, comments and strings are not definitions', () => {
        no('a.ts', 'run', [
            '        return this.run(id);', '    run(data);', '    run(data).then(() => {', 'runs(data) {', 'const runner = run;',
            '    if (run(x)) {', 'describe(\'run\', () => {', '// function run() is gone', ' * class run', 'const s = \'function run\';',
            'export { run } from \'./run\';', 'import { run } from \'./run\';', 'import type run from \'./run\';',
            'const { run } = require(\'./run\');', 'const run = require(\'./run\');', '    this.run = run;',
        ]);
    });

    it('Python: def, class and module-level assignments', () => {
        yes('a.py', 'run', ['def run(self):', '    async def run(self, data):']);
        yes('a.py', 'Action', ['class Action(Base):', 'class Action:']);
        yes('a.py', 'MAX_SIZE', ['MAX_SIZE = 3', 'MAX_SIZE: int = 3']);
        no('a.py', 'run', ['    run(data)', '    return run()', '    run = 3', 'from tools import run', '# def run', 'x == run']);
    });

    it('Java, Kotlin, C#, Go, Rust, PHP, Ruby: type and function keywords, method signatures', () => {
        yes('A.java', 'Action', ['public class Action {', 'public record Action(String id) {', 'public interface Action {', 'enum Action {']);
        yes('a.kt', 'Action', ['data class Action(val id: String)', 'object Action {']);
        yes('A.cs', 'Action', ['public sealed class Action : Base {']);
        yes('a.go', 'Action', ['type Action struct {']);
        yes('a.rs', 'Action', ['pub struct Action {', 'trait Action {']);
        yes('a.rb', 'Action', ['class Action < Base', 'module Action']);
        yes('A.java', 'run', [
            'public static void run(String[] args) {', '    @Override public Optional<String> run() {', '    Map<String, Integer> run(int a) {',
            '    private static final int run = 3;',
        ]);
        yes('A.cs', 'run', ['    public async Task<int> run(int id) {']);
        yes('a.kt', 'run', ['fun run(data: Data) {', 'fun <T> run(x: T): T {', 'fun String.run(): Int {', '    val run = 1']);
        yes('a.go', 'run', ['func run(data Data) error {', 'func (a *Action) run() error {']);
        yes('a.rs', 'run', ['pub fn run(&self) {']);
        yes('a.php', 'run', ['    public function run($data) {']);
        yes('a.rb', 'run', ['def run(data)', 'def self.run']);
        no('A.java', 'run', [
            '    return run(x);', '    x.run(1);', '    if (run(x)) {', '    run(x);', '    go run(x)', '    defer run()',
            'import com.acme.run;', 'use App\\Jobs\\run;', 'impl run {', '    throw new run(x);', '    String s = run(x);',
            '// fun run()',
        ]);
    });

    it('Java, Kotlin, C#, Go, Rust, PHP, Ruby: control flow without parentheses calls the name, it does not define it', () => {
        for (const path of ['a.go', 'a.rs', 'a.rb', 'A.java']) {
            no(path, 'run', [
                '    if run(x) {', '    } else if run(x) {', '    for run() {', '    switch run(x) {', '    select run(x)',
                '    match run(x) {', '    while run(x) {', '    loop run(x)', '    elsif run(x)', '    unless run(x)',
                '    until run(x)', '    foreach run(x)', '    catch run(x)', '    lock run(x)', '    using run(x)',
                '    with run(x)', '    guard run(x) else {', '    do run(x)', '    elif run(x):',
            ]);
        }
        // a call on another line keeps finding the real definition only
        yes('a.go', 'run', ['func run(x int) bool {']);
    });

    it('a method signature `Type name(` in Java and C# only: elsewhere a word before a call is a call', () => {
        yes('A.java', 'isValid', ['    boolean isValid(String x) {']);
        yes('A.cs', 'IsValid', ['    public bool IsValid(string x) {']);
        no('a.rb', 'isValid', ['    assert_equal isValid(x), y', '    puts format isValid(x)']);
        no('a.kt', 'isValid', ['        a to isValid(x),', '    val pair = a to isValid(x)']);
        no('a.go', 'isValid', ['    bool isValid(x)']);
    });

    it('a line too long for the patterns (minified code, data) is skipped, and fast', () => {
        expect(definesSymbol(`export const run = 1;${' '.repeat(2000)}`, 'run', 'a.ts')).toBe(false);
        expect(definesSymbol(`export const run = 1;${' '.repeat(1900)}`, 'run', 'a.ts')).toBe(true);
        const start = performance.now();
        expect(definesSymbol(`run:${' x'.repeat(64000)}`, 'run', 'a.ts')).toBe(false);
        expect(performance.now() - start).toBeLessThan(50);
    });
});

describe('findDefinitions', () => {
    const files = [
        file('src/a.ts', hunk([...ctx('import { Foo } from \'./b\';'), ['+', 'export const Foo = 1;']])),
        file('src/b.ts', hunk([...ctx('// b'), ['+', 'export class Foo {'], ...ctx('}')])),
        file('src/c.ts', hunk([['-', 'export function Foo() {'], ...ctx('}')])),
        file('tools/d.py', hunk(ctx('class Foo:'))),
    ];

    it('the file clicked first, then the others in list order; only the files of the same language family', () => {
        expect(where(findDefinitions(files, 'Foo', 1))).toEqual(['src/b.ts:new:2', 'src/a.ts:new:2']);
        expect(where(findDefinitions(files, 'Foo', 0))).toEqual(['src/a.ts:new:2', 'src/b.ts:new:2']);
        expect(where(findDefinitions(files, 'Foo', 3))).toEqual(['tools/d.py:new:1']);
    });

    it('the lines of the new side first; removed lines only when the new side has none', () => {
        const onlyRemoved = [files[2]!, file('src/e.ts', hunk([['-', 'class Foo {}'], ['+', 'class Bar {}']]))];
        expect(where(findDefinitions(onlyRemoved, 'Foo', 1))).toEqual(['src/e.ts:old:1', 'src/c.ts:old:1']);
    });

    it('a file restricted to one path (the file an import points to)', () => {
        expect(where(findDefinitions(files, 'Foo', 0, 'src/b.ts'))).toEqual(['src/b.ts:new:2']);
    });

    it('a method signature only in the Java and C# files of the family', () => {
        const mixed = [
            file('src/Check.kt', hunk(ctx('    val ok = a to isValid(x)'))),
            file('src/Rules.java', hunk(ctx('    boolean isValid(String x) {'))),
        ];
        expect(where(findDefinitions(mixed, 'isValid', 0))).toEqual(['src/Rules.java:new:1']);
    });

    it('a file without family (JSON, Markdown) is never searched', () => {
        expect(findDefinitions([file('package.json', hunk(ctx('"class Foo": 1')))], 'Foo', 0)).toEqual([]);
    });
});

describe('findImport', () => {
    const imported = (rows: string[], name: string, path = 'src/web/a.ts', side: DiffLine['t'] = ' ') =>
        findImport(file(path, hunk(rows.map((text) => [side, text] as const))), 0, name);

    it('TypeScript / JavaScript: named, default, namespace and require imports', () => {
        expect(imported(['import { Bar, Foo } from \'./foo\';'], 'Foo')).toMatchObject({ index: 0, spec: './foo' });
        expect(imported(['import Foo from "../foo/index";'], 'Foo')).toMatchObject({ index: 0, spec: '../foo/index' });
        expect(imported(['import * as Foo from \'./foo\';'], 'Foo')).toMatchObject({ index: 0, spec: './foo' });
        expect(imported(['import { Bar as Foo } from \'./foo\';'], 'Foo')).toMatchObject({ index: 0, spec: './foo' });
        expect(imported(['export { Foo } from \'./foo\';'], 'Foo')).toMatchObject({ index: 0, spec: './foo' });
        expect(imported(['const { Foo } = require(\'./foo\');'], 'Foo')).toMatchObject({ index: 0, spec: './foo' });
        expect(imported(['const Foo = require(\'./foo\');'], 'Foo')).toMatchObject({ index: 0, spec: './foo' });
    });

    it('TypeScript / JavaScript: a multi-line import gives the line naming the symbol, even cut by the hunk', () => {
        const rows = ['import {', '    Bar,', '    type Foo,', '} from \'./foo\';', 'const x = Foo;'];
        expect(imported(rows, 'Foo')).toMatchObject({ index: 2, spec: './foo' });
        expect(imported(rows.slice(1), 'Foo')).toMatchObject({ index: 1, spec: './foo' });
        expect(imported(['const {', '    Foo,', '} = require(\'./foo\');'], 'Foo')).toMatchObject({ index: 1, spec: './foo' });
        expect(imported(['const {', '    Foo,', '} = props;'], 'Foo')).toBeNull();
    });

    it('TypeScript / JavaScript: a block opened by a function or an object is not an import list', () => {
        const inFunction = ['export function load() {', '    const Foo = require(\'./foo\');', '    return Foo;', '}'];
        expect(imported(inFunction, 'Foo')).toMatchObject({ index: 1, spec: './foo' });
        const inObject = ['export default {', '    load() {', '        const Foo = require(\'./foo\');', '    },', '};'];
        expect(imported(inObject, 'Foo')).toMatchObject({ index: 2, spec: './foo' });
        // the function line itself is not part of an import
        expect(imported(['export function Foo() {', '    const x = require(\'./foo\');', '}'], 'Foo')).toBeNull();
    });

    it('the symbol named only in the path, or not imported: nothing', () => {
        expect(imported(['import x from \'./Foo\';'], 'Foo')).toBeNull();
        expect(imported(['import \'./Foo.css\';'], 'Foo')).toBeNull();
        expect(imported(['const Foo = 1;'], 'Foo')).toBeNull();
    });

    it('Python, Java / Kotlin and PHP / Rust use: the line, without a path to resolve; Go imports are skipped', () => {
        expect(imported(['from .models import Bar, Foo'], 'Foo', 'app/a.py')).toMatchObject({ index: 0, spec: null });
        expect(imported(['from .models import (', '    Bar,', '    Foo,', ')'], 'Foo', 'app/a.py')).toMatchObject({ index: 2, spec: null });
        expect(imported(['import numpy as Foo'], 'Foo', 'app/a.py')).toMatchObject({ index: 0 });
        expect(imported(['import com.acme.Foo;'], 'Foo', 'A.java')).toMatchObject({ index: 0, spec: null });
        expect(imported(['use App\\Models\\Foo;'], 'Foo', 'a.php')).toMatchObject({ index: 0 });
        expect(imported(['import "fmt"'], 'fmt', 'a.go')).toBeNull();
    });

    it('the new side first, then the removed lines', () => {
        const ref = findImport(file('src/a.ts', hunk([['-', 'import { Foo } from \'./old\';'], ['+', 'import { Foo } from \'./new\';']])), 0, 'Foo');
        expect(ref).toMatchObject({ side: 'new', spec: './new' });
        const removed = findImport(file('src/a.ts', hunk([['-', 'import { Foo } from \'./old\';'], ['+', 'import { Bar } from \'./new\';']])), 0, 'Foo');
        expect(removed).toMatchObject({ side: 'old', spec: './old' });
    });
});

describe('resolveImport', () => {
    const paths = ['src/web/b.ts', 'src/lib/c.vue', 'src/web/dir/index.ts', 'src/web/d.tsx', 'src/web/e.js'];

    it('a relative path to a file of the PR, with or without extension, or a folder index', () => {
        expect(resolveImport('src/web/a.ts', './b', paths)).toBe('src/web/b.ts');
        expect(resolveImport('src/web/a.ts', './b.ts', paths)).toBe('src/web/b.ts');
        expect(resolveImport('src/web/a.ts', './b.js', paths)).toBe('src/web/b.ts');
        expect(resolveImport('src/web/a.ts', '../lib/c', paths)).toBe('src/lib/c.vue');
        expect(resolveImport('src/web/a.ts', '../lib/c.vue', paths)).toBe('src/lib/c.vue');
        expect(resolveImport('src/web/a.ts', './dir', paths)).toBe('src/web/dir/index.ts');
        expect(resolveImport('src/web/a.ts', './d', paths)).toBe('src/web/d.tsx');
        expect(resolveImport('src/web/a.ts', './e', paths)).toBe('src/web/e.js');
        expect(resolveImport('src/web/x/a.ts', '../b', paths)).toBe('src/web/b.ts');
    });

    it('packages, aliases, files outside the PR or above the root: nothing', () => {
        expect(resolveImport('src/web/a.ts', 'vue', paths)).toBeNull();
        expect(resolveImport('src/web/a.ts', '@/web/b', paths)).toBeNull();
        expect(resolveImport('src/web/a.ts', './missing', paths)).toBeNull();
        expect(resolveImport('a.ts', '../../b', paths)).toBeNull();
    });
});

describe('gotoDefinition', () => {
    const spec = file('tests/ActionSpec.ts', hunk([
        ['+', 'import { Action } from \'../src/Action\';'],
        ['+', 'import { buildPayload } from \'./helpers\';'],
        ['+', 'import { Repo } from \'../src/Repo\';'],
        ['+', 'describe(\'Action\', () => {'],
        ['+', '    it(\'saves\', () => new Action(new Repo()).run(buildPayload()));'],
        ['+', '});'],
    ]));
    const action = file('src/Action.ts', hunk([
        ...ctx('export class Action {', '    constructor(repo) {}'),
        ['-', '    run(data) {'],
        ['+', '    run(data, options) {'],
        ...ctx('    }', '}'),
    ]));
    const repo = file('src/Repo.ts', hunk([...ctx('    save(id) {'), ['+', '        return id;'], ...ctx('    }')]));
    const twice = file('src/Twice.ts', hunk([['+', 'export function run() {}'], ['+', 'export function run(x) {}']]));
    const files = [action, spec, repo];
    const at = (f: FileDiff, index: number) => ({ fileIdx: files.indexOf(f), line: f.hunks[0]!.lines[index]! });

    it('one definition in another file: jump to it', () => {
        const result = gotoDefinition(files, 'Action', at(spec, 4));
        expect(result.kind).toBe('jump');
        expect(result.kind === 'jump' && where([result.target])).toEqual(['src/Action.ts:new:1']);
    });

    it('several definitions: the choice, the clicked file first', () => {
        const result = gotoDefinition([action, twice], 'run', { fileIdx: 0, line: action.hunks[0]!.lines[2]! });
        expect(result.kind).toBe('choose');
        expect(result.kind === 'choose' && where(result.targets)).toEqual(['src/Action.ts:new:3', 'src/Twice.ts:new:1', 'src/Twice.ts:new:2']);
    });

    it('the definition line itself: nothing to do', () => {
        expect(gotoDefinition(files, 'Action', at(action, 0))).toEqual({ kind: 'none' });
        expect(gotoDefinition(files, 'run', at(action, 3))).toEqual({ kind: 'none' });
    });

    it('a removed definition line clicked: the definition on the new side', () => {
        const result = gotoDefinition(files, 'run', at(action, 2));
        expect(result.kind === 'jump' && where([result.target])).toEqual(['src/Action.ts:new:3']);
    });

    it('no definition shown: the import in the same file, with the file of the PR it points to', () => {
        const helper = gotoDefinition(files, 'buildPayload', at(spec, 4));
        expect(helper).toMatchObject({ kind: 'import', file: null, here: false });
        expect(helper.kind === 'import' && where([helper.target])).toEqual(['tests/ActionSpec.ts:new:2']);
        const save = gotoDefinition([spec, file('src/Repo.ts', hunk([['+', '// repo']]))], 'Repo', { fileIdx: 0, line: spec.hunks[0]!.lines[4]! });
        expect(save).toMatchObject({ kind: 'import', file: 'src/Repo.ts', here: false });
    });

    it('the import line itself clicked: no jump, the file it points to is still offered', () => {
        const result = gotoDefinition([spec, repo], 'Repo', { fileIdx: 0, line: spec.hunks[0]!.lines[2]! });
        expect(result).toMatchObject({ kind: 'import', file: 'src/Repo.ts', here: true });
    });

    it('nothing found', () => {
        expect(gotoDefinition(files, 'describe', at(spec, 3))).toEqual({ kind: 'notFound' });
    });
});

describe('findLine', () => {
    it('finds a shown line by side and number (a context line from either side)', () => {
        const f = file('src/a.ts', hunk([...ctx('a'), ['-', 'b'], ['+', 'B'], ...ctx('c')]));
        expect(findLine([f], 'src/a.ts', 'old', 2)).toMatchObject({ hunk: 0, index: 1, side: 'old' });
        expect(findLine([f], 'src/a.ts', 'new', 2)).toMatchObject({ hunk: 0, index: 2, side: 'new' });
        expect(findLine([f], 'src/a.ts', 'old', 3)).toMatchObject({ index: 3, side: 'old' });
        expect(findLine([f], 'src/a.ts', 'new', 9)).toBeNull();
        expect(findLine([f], 'src/z.ts', 'new', 1)).toBeNull();
    });
});

describe('string stripping cost', () => {
    it('stays linear on an unterminated string full of escaped quotes', () => {
        const line = 'x"' + '\\"'.repeat(1000);
        const start = performance.now();
        definesSymbol(line, 'x', 'a.ts');
        expect(performance.now() - start).toBeLessThan(50);
    });
});
