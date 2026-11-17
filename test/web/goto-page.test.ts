import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Comparison, DiffLine, FileDiff, PrDetail } from '../../src/shared/api.ts';
import type { GotoClick } from '../../src/web/composables/useGotoDefinition.ts';
import { providePrPage, type PrPage } from '../../src/web/composables/usePrPage.ts';
import { findLine } from '../../src/web/lib/goto-definition.ts';
import { prLong } from './fixtures.ts';

const { api } = vi.hoisted(() => ({ api: { pr: vi.fn(), summary: vi.fn(), compare: vi.fn() } }));
vi.mock('../../src/web/services/api.ts', async (importOriginal) => ({ ...await importOriginal<object>(), api }));
vi.mock('../../src/web/composables/useErrors.ts', () => ({ showError: vi.fn() }));

const ref = { workspace: 'acme', repo: 'records-api', id: 212 };
const WHOLE_FILE = 100000;

const line = (t: DiffLine['t'], n: number, text: string): DiffLine => ({ t, o: t === '+' ? null : n, n: t === '-' ? null : n, text, hl: [] });
const file = (path: string, lines: DiffLine[]): FileDiff => ({
    path, oldPath: null, status: 'modified', category: 'code', binary: false, tooLarge: false, added: 1, removed: 0,
    contentHash: 'h', conflict: false, threads: [], hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: '', lines }],
});

/** src/spec.ts imports Repo from ./repo; its class line shows only with the whole file. */
function comparison(from: number, to: number, context: number): Comparison {
    const repo = context === WHOLE_FILE
        ? [line(' ', 1, 'export class Repo {'), line(' ', 2, '    save() {'), line('+', 3, '        return 1;'), line(' ', 4, '    }'), line(' ', 5, '}')]
        : [line(' ', 2, '    save() {'), line('+', 3, '        return 1;'), line(' ', 4, '    }')];
    return {
        from, to, stats: { files: 2, added: 3, removed: 0 }, masterOnly: [], messageChanged: false, messageFrom: '', messageTo: '',
        files: [
            file('src/spec.ts', [line('+', 1, 'import { Repo } from \'./repo\';'), line('+', 2, 'const repo = new Repo();'), line('+', 3, 'describe(repo);')]),
            file('src/repo.ts', repo),
        ],
    };
}

describe('go to definition on the PR page', () => {
    let detail: PrDetail;
    let unmount: () => void = () => undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        detail = prLong().data;
        api.summary.mockReturnValue(new Promise(() => undefined));
        api.pr.mockReturnValue(new Promise(() => undefined));
        api.compare.mockImplementation((_ref: unknown, from: number, to: number, context: number) => Promise.resolve(comparison(from, to, context)));
    });

    afterEach(() => unmount());

    async function mountPage(): Promise<PrPage> {
        let page: PrPage | null = null;
        const Root = defineComponent({
            setup() {
                page = providePrPage(ref, detail);
                return () => null;
            },
        });
        const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/pr/:ws/:repo/:id', name: 'pr', component: Root }] });
        await router.push(`/pr/${ref.workspace}/${ref.repo}/${ref.id}?from=7&to=10`);
        const app = createApp(Root).use(router);
        app.mount(document.createElement('div'));
        unmount = () => app.unmount();
        if (!page) {
            throw new Error('page not created');
        }
        const created: PrPage = page;
        await vi.waitFor(() => expect(created.compare?.from).toBe(7));
        return created;
    }

    /** A Ctrl/⌘+click on `name` in line `n` of src/spec.ts. */
    function click(page: PrPage, name: string, n: number): GotoClick {
        const at = findLine(page.compare?.files ?? [], 'src/spec.ts', 'new', n);
        if (!at) {
            throw new Error(`line ${n} not shown`);
        }
        return { name, ref: at, x: 10, top: 300, bottom: 320, origin: { path: 'src/spec.ts', side: 'new', number: n, top: 300, scrollY: 0 } };
    }

    it('an imported name defined outside the shown lines: its import, then its file with "whole file", then back twice', async () => {
        const page = await mountPage();
        await page.goto.follow(click(page, 'Repo', 2));
        expect(page.goto.target).toMatchObject({ path: 'src/spec.ts', index: 0, side: 'new' });
        expect(page.goto.notice).toMatchObject({ message: 'atImport', name: 'Repo', back: true, offer: { file: 'src/repo.ts', from: 'src/spec.ts' } });

        await page.goto.openOffer();
        expect(page.fullContext).toBe(true);
        expect(api.compare).toHaveBeenLastCalledWith(ref, 7, 10, WHOLE_FILE);
        expect(page.goto.target).toMatchObject({ path: 'src/repo.ts', index: 0, side: 'new' });
        expect(page.goto.notice).toMatchObject({ message: null, back: true, offer: null });

        // back: the import line, then the line clicked first
        expect(page.handleKey('ArrowLeft')).toBe(false);
        expect(page.handleKey('ArrowLeft', { altKey: true })).toBe(true);
        await vi.waitFor(() => expect(page.goto.target).toMatchObject({ path: 'src/spec.ts', index: 0 }));
        expect(page.handleKey('ArrowLeft', { altKey: true })).toBe(true);
        await vi.waitFor(() => expect(page.goto.target).toMatchObject({ path: 'src/spec.ts', index: 1 }));
        // nothing left: Alt+← is the browser's again
        expect(page.goto.canGoBack).toBe(false);
        expect(page.handleKey('ArrowLeft', { altKey: true })).toBe(false);
    });

    it('nothing found: the notice suggests "whole file" while it is off; Escape closes it; a new range forgets the places', async () => {
        const page = await mountPage();
        await page.goto.follow(click(page, 'describe', 3));
        expect(page.goto.target).toBeNull();
        expect(page.goto.notice).toMatchObject({ message: 'notFound', name: 'describe', hint: true, back: false });
        expect(page.handleKey('Escape')).toBe(true);
        expect(page.goto.notice).toBeNull();
        expect(page.handleKey('Escape')).toBe(false);

        await page.goto.follow(click(page, 'Repo', 2));
        expect(page.goto.canGoBack).toBe(true);
        page.select(8, 10);
        await vi.waitFor(() => expect(page.compare?.from).toBe(8));
        expect(page.goto.canGoBack).toBe(false);
        expect(page.goto.notice).toBeNull();
    });

    it('the import line clicked itself: no jump, the file of the PR it points to is offered', async () => {
        const page = await mountPage();
        await page.goto.follow(click(page, 'Repo', 1));
        expect(page.goto.target).toBeNull();
        expect(page.goto.notice).toMatchObject({ message: 'notShown', back: false, offer: { file: 'src/repo.ts' } });
        await page.goto.openOffer();
        expect(page.goto.target).toMatchObject({ path: 'src/repo.ts', index: 0 });
        // back to the import line clicked
        expect(page.goto.canGoBack).toBe(true);
    });

    it('"whole file" on: the definition outside the hunks shows at once; not found has no hint', async () => {
        const page = await mountPage();
        page.fullContext = true;
        await vi.waitFor(() => expect(api.compare).toHaveBeenLastCalledWith(ref, 7, 10, WHOLE_FILE));
        // with the whole file, the class line is shown: found at once
        await page.goto.follow(click(page, 'Repo', 2));
        expect(page.goto.target).toMatchObject({ path: 'src/repo.ts', index: 0 });
        await page.goto.follow(click(page, 'missing', 1));
        expect(page.goto.notice).toMatchObject({ message: 'notFound', hint: false });
    });
});
