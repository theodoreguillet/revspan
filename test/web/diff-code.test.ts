import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from 'vue';
import type { DiffLine } from '../../src/shared/api.ts';
import DiffCode from '../../src/web/components/DiffCode.vue';
import type { CodeToken } from '../../src/web/lib/highlight.ts';

const KEYWORD = '#569CD6';
const VARIABLE = '#9CDCFE';
const FUNCTION = '#DCDCAA';
const TEXT = 'const ok = validatePayloadData(this.payload, options);';
const TOKENS: CodeToken[] = [
    { content: 'const', color: KEYWORD }, { content: ' ' }, { content: 'ok', color: VARIABLE }, { content: ' = ' },
    { content: 'validatePayloadData', color: FUNCTION }, { content: '(' }, { content: 'this', color: KEYWORD }, { content: '.' },
    { content: 'payload', color: VARIABLE }, { content: ',' }, { content: ' ' }, { content: 'options', color: VARIABLE }, { content: ');' },
];

let app: App | null = null;

function render(props: { line: DiffLine; tokens?: readonly CodeToken[]; marks?: readonly [number, number][]; cur?: number; family?: 'js' | null }): HTMLElement {
    const root = document.createElement('div');
    app = createApp(DiffCode, props);
    app.mount(root);
    return root.querySelector('.c')!;
}

afterEach(() => {
    app?.unmount();
    app = null;
});

describe('DiffCode', () => {
    it('draws one band (<em>) per change range, even across several syntax tokens', () => {
        const code = render({ line: { t: '+', o: null, n: 12, text: TEXT, hl: [[19, 26], [43, 52]] }, tokens: TOKENS });
        const bands = [...code.querySelectorAll('em')];
        expect(bands.map((em) => em.textContent)).toEqual(['Payload', ', options']);
        // ',' + ' ' + 'options': three tokens, one band; the token colors stay inside it.
        expect(bands[1]!.querySelector('span')!.getAttribute('style')).toContain(VARIABLE);
        expect(bands[0]!.querySelector('span')!.getAttribute('style')).toContain(FUNCTION);
        expect(code.textContent).toBe(TEXT);
    });

    it('keeps the search marks inside the band, the current one tagged', () => {
        // 'ad, o' starts before the band and ends inside it, 'tions' is the current match.
        const code = render({ line: { t: '+', o: null, n: 12, text: TEXT, hl: [[43, 52]] }, tokens: TOKENS, marks: [[41, 46], [47, 52]], cur: 47 });
        expect(code.querySelectorAll('em')).toHaveLength(1);
        expect(code.querySelector('em')!.textContent).toBe(', options');
        expect([...code.querySelectorAll('em mark')].map((m) => [m.textContent, m.classList.contains('cur')])).toEqual([[',', false], [' ', false], ['o', false], ['tions', true]]);
        expect([...code.querySelectorAll(':scope > mark')].map((m) => m.textContent)).toEqual(['ad']);
        expect(code.textContent).toBe(TEXT);
    });

    it('go to definition: names are tagged `sym`, keywords `nosym`, nothing for a file without family', () => {
        const line: DiffLine = { t: '+', o: null, n: 12, text: TEXT, hl: [[43, 52]] };
        const code = render({ line, tokens: TOKENS, family: 'js' });
        expect([...code.querySelectorAll('.sym')].map((el) => el.textContent)).toEqual(['ok', 'validatePayloadData', 'payload', 'options']);
        expect([...code.querySelectorAll('.nosym')].map((el) => el.textContent)).toEqual(['const', 'this']);
        expect(code.textContent).toBe(TEXT);
        app?.unmount();
        expect(render({ line, tokens: TOKENS, family: null }).querySelectorAll('.sym, .nosym')).toHaveLength(0);
    });

    it('plain text without tokens nor ranges', () => {
        const code = render({ line: { t: ' ', o: 1, n: 1, text: 'a = b', hl: [] } });
        expect(code.textContent).toBe('a = b');
        expect(code.children).toHaveLength(0);
    });
});
