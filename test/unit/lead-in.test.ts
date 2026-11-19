import { describe, expect, it } from 'vitest';
import type { Hunk } from '../../src/shared/api.ts';
import { leadInFor, withLeadIns } from '../../src/server/core/lead-in.ts';

const VUE = 'src/components/RecordList.vue';

/** A single-file component; the comments give the 1-based line numbers. */
const SFC = [
    '<template>', // 1
    '    <ul class="record-list">', // 2
    '        <template v-for="record in records" :key="record.id">', // 3 (slot-like nested template, indented)
    '            <li>{{ record.label }}</li>', // 4
    '        </template>', // 5
    '    </ul>', // 6
    '</template>', // 7
    '', // 8
    '<script setup lang="ts">', // 9
    "import { ref } from 'vue';", // 10
    '', // 11
    'const count = ref<number>(0);', // 12
    '</script>', // 13
    '', // 14
    '<style scoped lang="scss">', // 15
    '.record-list {', // 16
    '    margin: 0;', // 17
    '}', // 18
    '</style>', // 19
];

const at = (lines: readonly string[], path: string, ...firstLines: number[]): (string | null)[] =>
    firstLines.map((n) => leadInFor(lines, n, path));

describe('leadInFor', () => {
    it('gives the opening tag of the script or style block the line is in, its closing line included', () => {
        expect(at(SFC, VUE, 10, 11, 12, 13)).toEqual(Array(4).fill('<script setup lang="ts">'));
        expect(at(SFC, VUE, 16, 17, 18, 19)).toEqual(Array(4).fill('<style scoped lang="scss">'));
    });

    it('gives nothing on an opening tag line, between the blocks or past the end', () => {
        expect(at(SFC, VUE, 9, 15)).toEqual([null, null]);
        expect(at(SFC, VUE, 8, 14, 20, 0)).toEqual([null, null, null, null]);
    });

    it('gives nothing in the template: alone, its lines keep the Vue directive colors (the block would lose them)', () => {
        expect(at(SFC, VUE, 1, 2, 3, 4, 5, 6, 7)).toEqual(Array(7).fill(null));
    });

    it('Vue: a block opens with a tag at the start of a line, a script or style ends at its closing tag anywhere', () => {
        const sfc = [
            '<template>', // 1
            '<script-panel :record="record" />', // 2 (a component, not a block)
            '    <template #item="{ record }">', // 3
            '        <script setup lang="ts">', // 4 (not at the start of a line)
            '    </template>', // 5
            '</template>', // 6
            '<script setup lang="ts">', // 7
            "const tag = '<style>';", // 8
            'const total = 1; </script>', // 9 (raw text: the block ends here, as for Vue's parser)
            'outside', // 10
        ];
        expect(at(sfc, VUE, 8, 9)).toEqual(Array(2).fill('<script setup lang="ts">'));
        expect(at(sfc, VUE, 2, 3, 4, 5, 6, 7, 10)).toEqual(Array(7).fill(null));
    });

    it('a block opened and closed on one line, or a tag over several lines, gives nothing', () => {
        const sfc = [
            '<template><RecordList /></template>', // 1
            'outside', // 2
            '<style src="./list.css"></style>', // 3
            'outside', // 4
            '<script', // 5
            '    setup', // 6
            '    lang="ts"', // 7
            '>', // 8
            'const count = 1;', // 9
            '</script>', // 10
            '<script lang="ts">', // 11
            'const total = 2;', // 12
        ];
        expect(at(sfc, VUE, 2, 4)).toEqual([null, null]);
        expect(at(sfc, VUE, 6, 7, 8, 9, 10)).toEqual(Array(5).fill(null));
        expect(at(sfc, VUE, 12)).toEqual(['<script lang="ts">']);
    });

    it('HTML: script and style blocks anywhere in a line, the tag line given as is', () => {
        const page = [
            '<!doctype html>', // 1
            '<html>', // 2
            '<head>', // 3
            '    <style>', // 4
            '        body { margin: 0; }', // 5
            '    </style>', // 6
            '    <SCRIPT type="module">', // 7
            "        const app = document.querySelector('#app');", // 8
            "        app.append('<style>');", // 9
            '    </SCRIPT>', // 10
            '</head>', // 11
            '<body><script>window.ready = true;</script>', // 12
            '<template><p>Hi</p></template>', // 13
            '<div><script>', // 14
            'start();', // 15
        ];
        expect(at(page, 'public/index.html', 5, 6)).toEqual(['    <style>', '    <style>']);
        expect(at(page, 'public/index.html', 8, 9, 10)).toEqual(Array(3).fill('    <SCRIPT type="module">'));
        expect(at(page, 'public/index.html', 1, 4, 7, 11, 12, 13, 14)).toEqual(Array(7).fill(null));
        expect(at(page, 'public/INDEX.HTML', 15)).toEqual(['<div><script>']);
    });

    it('other files, a carriage return, a very long tag line', () => {
        expect(at(SFC, 'src/components/RecordList.ts', 12)).toEqual([null]);
        expect(at(SFC, 'src/components/RecordList.vue.orig', 12)).toEqual([null]);
        expect(at(['<script setup lang="ts">\r', 'const a = 1;\r'], VUE, 2)).toEqual(['<script setup lang="ts">']);
        expect(at([`<script>${'x'.repeat(2000)}`, 'const a = 1;'], 'index.html', 2)).toEqual([null]);
    });
});

describe('withLeadIns', () => {
    const hunk = (oldStart: number, oldLines: number, newStart: number, newLines: number): Hunk => ({ oldStart, oldLines, newStart, newLines, header: '', lines: [] });

    it('sets each side from its own lines, leaves out an empty side and a hunk without any', () => {
        // two lines added at the top of the new side: every line moves down by 2
        const now = ['<!-- list -->', '', ...SFC];
        const hunks = withLeadIns([hunk(1, 4, 1, 6), hunk(10, 4, 12, 4), hunk(16, 0, 18, 2), hunk(17, 1, 18, 0)], SFC, now, VUE);
        expect(hunks.map((h) => h.leadIn)).toEqual([
            undefined,
            { old: '<script setup lang="ts">', new: '<script setup lang="ts">' },
            { new: '<style scoped lang="scss">' },
            { old: '<style scoped lang="scss">' },
        ]);
        expect('leadIn' in hunks[0]!).toBe(false);
    });

    it('leaves the hunks of another kind of file as they are', () => {
        const hunks = [hunk(10, 4, 10, 4)];
        expect(withLeadIns(hunks, SFC, SFC, 'src/RecordList.ts')).toBe(hunks);
    });
});
