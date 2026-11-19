import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Comparison, DiffLine, FileDiff, PrDetail } from '../../src/shared/api.ts';
import DiffFile from '../../src/web/components/DiffFile.vue';
import { providePrPage, type PrPage } from '../../src/web/composables/usePrPage.ts';
import { composerTargetFor } from '../../src/web/lib/diff.ts';
import { prLong } from './fixtures.ts';

const { api } = vi.hoisted(() => ({ api: { pr: vi.fn(), summary: vi.fn(), compare: vi.fn(), comment: vi.fn() } }));
vi.mock('../../src/web/services/api.ts', async (importOriginal) => ({ ...await importOriginal<object>(), api }));
vi.mock('../../src/web/composables/useErrors.ts', () => ({ showError: vi.fn() }));

const ref = { workspace: 'acme', repo: 'records-api', id: 212 };
const A = 'src/Action.ts';
const B = 'src/Other.ts';

const line = (t: DiffLine['t'], o: number | null, n: number | null): DiffLine => ({ t, o, n, text: `${t}${o ?? ''}/${n ?? ''}`, hl: [] });
const fileDiff = (path: string, hunks: FileDiff['hunks']): FileDiff => ({
    path, oldPath: null, status: 'modified', category: 'code', binary: false, tooLarge: false, added: 1, removed: 1, contentHash: 'h', conflict: false, threads: [], hunks,
});

/** src/Action.ts: lines 1-8 (5 removed, 5-6 added) and 40-42 in a second hunk; src/Other.ts: lines 1-3. */
function comparison(from: number, to: number): Comparison {
    const hunkA = [line(' ', 1, 1), line(' ', 2, 2), line(' ', 3, 3), line(' ', 4, 4), line('-', 5, null), line('+', null, 5), line('+', null, 6), line(' ', 6, 7), line(' ', 7, 8)];
    const hunkB = [line(' ', 38, 40), line('+', null, 41), line(' ', 39, 42)];
    return {
        from, to, stats: { files: 2, added: 3, removed: 1 }, masterOnly: [], messageChanged: false, messageFrom: '', messageTo: '',
        files: [
            fileDiff(A, [
                { oldStart: 1, oldLines: 7, newStart: 1, newLines: 8, header: '', lines: hunkA },
                { oldStart: 38, oldLines: 2, newStart: 40, newLines: 3, header: '', lines: hunkB },
            ]),
            fileDiff(B, [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, header: '', lines: [line(' ', 1, 1), line('+', null, 2), line(' ', 2, 3)] }]),
        ],
    };
}

const target = (path: string, n: number) => composerTargetFor(path, line(' ', n, n), 'new')!;

describe('drag on a line\'s "+" to comment a range of lines', () => {
    let detail: PrDetail;
    let root: HTMLElement;
    let page: PrPage;
    let unmount: () => void = () => undefined;
    /** Queued animation frames, run by hand (frame()). */
    let frames: FrameRequestCallback[] = [];
    let now = 0;
    /** What the browser finds under the pointer. */
    let under: Element | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        detail = prLong().data;
        api.summary.mockReturnValue(new Promise(() => undefined));
        api.pr.mockReturnValue(new Promise(() => undefined));
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => Promise.resolve(comparison(from, to)));
        frames = [];
        now = 1000;
        under = null;
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
        vi.stubGlobal('cancelAnimationFrame', () => undefined);
        vi.spyOn(document, 'elementFromPoint').mockImplementation(() => under);
    });

    afterEach(() => {
        unmount();
        root?.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    async function mountPage(): Promise<void> {
        let created: PrPage | null = null;
        const Root = defineComponent({
            setup() {
                const p = providePrPage(ref, detail);
                created = p;
                return () => h('div', (p.compare?.files ?? []).map((file, idx) => h(DiffFile, { key: file.path, file, idx })));
            },
        });
        const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/pr/:ws/:repo/:id', name: 'pr', component: Root }] });
        await router.push(`/pr/${ref.workspace}/${ref.repo}/${ref.id}?from=7&to=10`);
        root = document.createElement('div');
        document.body.append(root);
        const app = createApp(Root).use(router);
        app.mount(root);
        unmount = () => app.unmount();
        if (!created) {
            throw new Error('page not created');
        }
        page = created;
        // the diff renders its rows over the next frames (progressive rendering)
        await vi.waitFor(async () => {
            await frame();
            expect(root.querySelectorAll('.rv-plus')).toHaveLength(15);
        });
    }

    const fileEl = (path = A): HTMLElement => root.querySelector<HTMLElement>(`.rv-file[data-path="${path}"]`)!;
    const row = (n: number, path = A): HTMLElement => fileEl(path).querySelector<HTMLElement>(`.rv-l[data-n="${n}"]`)!;
    const removedRow = (o: number): HTMLElement => fileEl().querySelector<HTMLElement>(`.rv-l[data-o="${o}"][data-n=""]`)!;
    const plus = (n: number, path = A): HTMLElement => row(n, path).querySelector<HTMLElement>('.rv-plus')!;
    /** The pointer over an element (over a line: its code, what elementFromPoint finds inside the row). */
    const over = (el: Element | null): void => {
        under = el?.matches('.rv-l') ? el.querySelector('.c') ?? el : el;
    };
    /** The composer is on new-side line n of src/Action.ts alone. */
    const onLine = (n: number): void => {
        expect(page.composer).toMatchObject({ path: A, kind: 'new', line: n, key: target(A, n).key });
        expect(page.composer?.startLine).toBeUndefined();
    };

    /** Pressed and released at y = 300 by default; a move goes 20 px lower (a real move: the drag starts after 4 px). */
    const pointer = (type: string, init: PointerEventInit = {}): PointerEvent => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: 120,
        clientY: type === 'pointermove' ? 320 : 300, ...init,
    });
    const press = (el: Element, init: PointerEventInit = {}): void => {
        el.dispatchEvent(pointer('pointerdown', init));
    };
    async function frame(): Promise<void> {
        now += 16;
        for (const cb of frames.splice(0)) {
            cb(now);
        }
        await nextTick();
    }
    /** Moves over `el`: the line under the pointer is read on the next frame. */
    async function moveTo(el: Element | null, init: PointerEventInit = {}): Promise<void> {
        over(el);
        window.dispatchEvent(pointer('pointermove', init));
        await frame();
    }
    async function release(on: Element = document.body, init: PointerEventInit = {}): Promise<void> {
        on.dispatchEvent(pointer('pointerup', init));
        await nextTick();
    }

    const marked = (path = A): (number | null)[] =>
        [...fileEl(path).querySelectorAll<HTMLElement>('.rv-l.in-range.composing')].map((el) => (el.dataset.n ? Number(el.dataset.n) : null));

    it('press on line 4, move over line 6 then 8: the lines between are marked as they go; release: the composer takes them', async () => {
        await mountPage();
        page.setDraft(target(A, 4).key, 'These lines');
        press(plus(4));
        expect(document.documentElement.classList.contains('rv-range-drag')).toBe(true);
        await moveTo(row(6));
        // new-side lines only: not the removed line 5
        expect(marked()).toEqual([4, 5, 6]);
        expect(removedRow(5).classList.contains('in-range')).toBe(false);
        expect(page.composer).toBeNull();
        await moveTo(row(8));
        expect(marked()).toEqual([4, 5, 6, 7, 8]);
        await release(row(8));
        expect(page.composer).toMatchObject({ path: A, line: 8, startLine: 4, key: target(A, 8).key });
        // as a click then a Shift+click: the text typed on the line pressed follows the composer to the last line
        expect(page.draft(target(A, 8).key)).toBe('These lines');
        expect(fileEl().querySelector('.rv-comp')?.previousElementSibling).toBe(row(8));
        expect(fileEl().querySelector('.rv-comp .q')?.textContent).toContain('Lines 4–8 of v10');
        expect(marked()).toEqual([4, 5, 6, 7, 8]);
        expect(document.documentElement.classList.contains('rv-range-drag')).toBe(false);
        // a browser that sends the click to the "+" released on: already handled, the range stays
        plus(8).click();
        expect(page.composer).toMatchObject({ line: 8, startLine: 4 });
        // a later Shift+click grows the range from the line pressed
        plus(2).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        expect(page.composer).toMatchObject({ line: 4, startLine: 2 });
    });

    it('release on the line pressed, without leaving it: that line alone, as a plain click (nothing marked meanwhile)', async () => {
        await mountPage();
        press(plus(4));
        await moveTo(row(4));
        expect(marked()).toEqual([]);
        await release(plus(4));
        onLine(4);
        plus(4).click();
        onLine(4);
        // back on the line pressed after leaving it: that line alone too
        press(plus(6));
        await moveTo(row(7));
        await moveTo(row(6));
        expect(marked()).toEqual([6]);
        await release(row(6));
        onLine(6);
        // and upwards
        press(plus(7));
        await moveTo(row(2));
        expect(marked()).toEqual([2, 3, 4, 5, 6, 7]);
        await release(row(2));
        expect(page.composer).toMatchObject({ line: 7, startLine: 2 });
    });

    it('over a removed line, a hunk header, a gap, another file or nothing: the range keeps the last line; it may span two hunks', async () => {
        await mountPage();
        press(plus(4));
        await moveTo(row(6));
        for (const el of [removedRow(5), fileEl().querySelectorAll('.rv-hunk')[1]!, fileEl(), row(2, B), fileEl(B), null]) {
            await moveTo(el);
            expect(marked()).toEqual([4, 5, 6]);
        }
        expect(marked(B)).toEqual([]);
        await moveTo(row(41));
        expect(marked()).toEqual([4, 5, 6, 7, 8, 40, 41]);
        await release(fileEl(B));
        expect(page.composer).toMatchObject({ path: A, line: 41, startLine: 4 });
    });

    it('Escape cancels: the composer open before stays as it was, with its range shown again; nothing reaches the page', async () => {
        await mountPage();
        page.openComposer(target(A, 40));
        page.openComposer(target(A, 41), true);
        await nextTick();
        page.setDraft(target(A, 41).key, 'Kept');
        expect(marked()).toEqual([40, 41]);
        const before = page.composer;
        press(plus(2));
        await moveTo(row(3));
        // while dragging, only the lines being selected show as such
        expect(marked()).toEqual([2, 3]);
        const textarea = fileEl().querySelector('textarea')!;
        const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        textarea.dispatchEvent(key);
        await nextTick();
        expect(key.defaultPrevented).toBe(true);
        expect(page.composer).toEqual(before);
        expect(page.draft(target(A, 41).key)).toBe('Kept');
        expect(marked()).toEqual([40, 41]);
        expect(document.documentElement.classList.contains('rv-range-drag')).toBe(false);
        // the release that follows does nothing, and the next Escape is the composer's again
        await release(row(3));
        expect(page.composer).toEqual(before);
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(page.composer).toBeNull();
    });

    it('a release outside the window, a cancelled pointer, the window losing focus or a move with no button pressed: cancelled', async () => {
        await mountPage();
        const ends: [string, () => Promise<void>][] = [
            ['release below the window', () => release(document.body, { clientY: window.innerHeight + 40 })],
            ['release left of the window', () => release(document.body, { clientX: -5 })],
            ['pointercancel', async () => {
                window.dispatchEvent(pointer('pointercancel'));
                await nextTick();
            }],
            ['blur', async () => {
                window.dispatchEvent(new Event('blur'));
                await nextTick();
            }],
            ['released where the page could not see it', () => moveTo(row(3), { buttons: 0 })],
        ];
        for (const [what, end] of ends) {
            press(plus(2));
            await moveTo(row(6));
            expect(marked(), what).toEqual([2, 3, 4, 5, 6]);
            await end();
            expect(marked(), what).toEqual([]);
            expect(page.composer, what).toBeNull();
            expect(document.documentElement.classList.contains('rv-range-drag'), what).toBe(false);
            // a later release changes nothing
            await release(row(6));
            expect(page.composer, what).toBeNull();
        }
    });

    it('no drag from Shift (Shift+click as before), another button, a touch, or a removed line\'s "+"', async () => {
        await mountPage();
        page.openComposer(target(A, 2));
        press(plus(6), { shiftKey: true });
        await moveTo(row(8));
        expect(marked()).toEqual([]);
        await release(plus(6));
        expect(page.composer).toEqual(target(A, 2));
        plus(6).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        expect(page.composer).toMatchObject({ line: 6, startLine: 2 });

        for (const init of [{ button: 2 }, { pointerType: 'touch' }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
            press(plus(3), init);
            await moveTo(row(8));
            expect(marked(), JSON.stringify(init)).toEqual([2, 3, 4, 5, 6]);
            await release(row(8));
            expect(page.composer, JSON.stringify(init)).toMatchObject({ line: 6, startLine: 2 });
        }

        page.closeComposer();
        const removedPlus = removedRow(5).querySelector<HTMLElement>('.rv-plus')!;
        press(removedPlus);
        await moveTo(row(8));
        expect(marked()).toEqual([]);
        await release(row(8));
        removedPlus.click();
        expect(page.composer).toMatchObject({ kind: 'old', line: 5 });
    });

    it('near the bottom edge the page scrolls, the range follows the line under the pointer, a j/k/v pin is released', async () => {
        await mountPage();
        page.tlHeight = 150;
        page.toolbarHeight = 40;
        let fileBottom = window.innerHeight + 300;
        fileEl().getBoundingClientRect = () => ({ top: -100, bottom: fileBottom, left: 0, right: 800, width: 800, height: fileBottom + 100, x: 0, y: -100, toJSON: () => ({}) });
        let y = 0;
        vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => y);
        const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(((_x: number, dy: number) => {
            y += dy;
            fileBottom -= dy;
        }) as typeof window.scrollBy);
        // a file reached by j: pinned until the user scrolls away
        page.pinFile();
        expect(page.pinHolds()).toBe(true);

        press(plus(2), { clientY: 400 });
        await moveTo(row(3), { clientY: 400 });
        expect(scrollBy).not.toHaveBeenCalled();
        // the pointer goes down to the bottom edge and stays there: the page scrolls on every frame
        await moveTo(row(6), { clientY: window.innerHeight - 4 });
        expect(scrollBy).toHaveBeenCalled();
        const steps = scrollBy.mock.calls.map((call) => call[1] as unknown as number);
        expect(steps.every((dy) => dy > 0)).toBe(true);
        expect(page.pinHolds()).toBe(false);
        expect(marked()).toEqual([2, 3, 4, 5, 6]);
        // content moved under the still pointer: the next frame reads the line now there
        over(row(41));
        await frame();
        expect(marked()).toEqual([2, 3, 4, 5, 6, 7, 8, 40, 41]);
        // the file's last line came above the bottom edge: no more scrolling
        fileBottom = window.innerHeight - 10;
        const calls = scrollBy.mock.calls.length;
        await frame();
        await frame();
        expect(scrollBy.mock.calls.length).toBe(calls);
        await release(row(41), { clientY: window.innerHeight - 4 });
        expect(page.composer).toMatchObject({ line: 41, startLine: 2 });
        // nothing scrolls once released
        await frame();
        expect(scrollBy.mock.calls.length).toBe(calls);
    });

    it('near the top edge (under the sticky bars) the page scrolls up; over the bars the range reads the first line under them', async () => {
        await mountPage();
        page.tlHeight = 150;
        page.toolbarHeight = 40;
        fileEl().getBoundingClientRect = () => ({ top: -600, bottom: 900, left: 0, right: 800, width: 800, height: 1500, x: 0, y: -600, toJSON: () => ({}) });
        const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
        const fromPoint = vi.mocked(document.elementFromPoint);
        press(plus(41), { clientY: 500 });
        // over the timeline: the pointer is above the diff, the line read is the one right under the bars
        await moveTo(row(8), { clientY: 60 });
        expect(scrollBy.mock.calls.at(-1)?.[1]).toBeLessThan(0);
        expect(fromPoint.mock.calls.at(-1)?.[1]).toBeGreaterThan(190);
        expect(marked()).toEqual([8, 40, 41]);
        await release(row(8), { clientY: 60 });
        expect(page.composer).toMatchObject({ line: 41, startLine: 8 });
    });

    /** The diff read under bars of 190 px; the file's box (its lines, top to bottom) as given; scrollBy recorded. */
    function layout(top: number, bottom: number) {
        page.tlHeight = 150;
        page.toolbarHeight = 40;
        fileEl().getBoundingClientRect = () => ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
        return vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    }

    it('a click on a "+" near the bottom edge, without moving: that line alone, the page does not scroll, a j/k pin holds', async () => {
        await mountPage();
        const scrollBy = layout(-500, window.innerHeight + 500);
        page.pinFile();
        const y = window.innerHeight - 10;
        over(row(6));
        press(plus(6), { clientY: y });
        // held still for a few frames (a slow click), the page under the pointer moving or not
        for (let k = 0; k < 6; k++) {
            over(row(7 + k));
            await frame();
        }
        expect(marked()).toEqual([]);
        await release(plus(6), { clientY: y });
        onLine(6);
        expect(scrollBy).not.toHaveBeenCalled();
        expect(page.pinHolds()).toBe(true);
    });

    it('a click on a "+" near the top edge (a search match or a definition lands there): that line alone, no scroll', async () => {
        await mountPage();
        const scrollBy = layout(-400, window.innerHeight + 500);
        page.pinFile();
        const y = 190 + 30;
        over(row(3));
        press(plus(3), { clientY: y });
        // a jitter of a few pixels is still a click
        over(row(2));
        window.dispatchEvent(pointer('pointermove', { clientX: 123, clientY: y - 2 }));
        for (let k = 0; k < 6; k++) {
            await frame();
        }
        expect(marked()).toEqual([]);
        await release(row(2), { clientX: 123, clientY: y - 2 });
        onLine(3);
        expect(scrollBy).not.toHaveBeenCalled();
        expect(page.pinHolds()).toBe(true);
    });

    it('pressed near an edge, the page scrolls once the pointer has moved more than 4 px', async () => {
        await mountPage();
        const scrollBy = layout(-500, window.innerHeight + 500);
        const y = window.innerHeight - 30;
        press(plus(6), { clientY: y });
        await moveTo(row(6), { clientY: y + 4 });
        await frame();
        expect(scrollBy).not.toHaveBeenCalled();
        await moveTo(row(7), { clientY: y + 6 });
        expect(scrollBy).toHaveBeenCalled();
        expect(marked()).toEqual([6, 7]);
        await release(row(7), { clientY: y + 6 });
        expect(page.composer).toMatchObject({ line: 7, startLine: 6 });
    });

    it('a release far from the press with no move seen in between (a fast flick) still selects the range', async () => {
        await mountPage();
        press(plus(2));
        over(row(6));
        await release(row(6), { clientY: 380 });
        expect(page.composer).toMatchObject({ line: 6, startLine: 2 });
    });

    it('a new comparison (another range of versions) stops a live drag: nothing marked, the release does nothing', async () => {
        await mountPage();
        press(plus(2));
        await moveTo(row(6));
        expect(marked()).toEqual([2, 3, 4, 5, 6]);
        page.select(8, 10);
        await vi.waitFor(() => expect(page.compare?.from).toBe(8));
        await nextTick();
        expect(marked()).toEqual([]);
        expect(document.documentElement.classList.contains('rv-range-drag')).toBe(false);
        await release(row(6));
        expect(page.composer).toBeNull();
    });

    it('side by side: the line is read in the new column, only its cells are marked', async () => {
        await mountPage();
        page.view = 'split';
        try {
            await vi.waitFor(async () => {
                await frame();
                expect(fileEl().querySelector('.rv-sl .half[data-n="4"] .rv-plus')).not.toBeNull();
            });
            const cell = (n: number): HTMLElement => fileEl().querySelector<HTMLElement>(`.half[data-n="${n}"]`)!;
            const cells = (): (number | null)[] =>
                [...fileEl().querySelectorAll<HTMLElement>('.half.in-range.composing')].map((el) => (el.dataset.n ? Number(el.dataset.n) : null));
            press(cell(4).querySelector('.rv-plus')!);
            await moveTo(cell(6));
            expect(cells()).toEqual([4, 5, 6]);
            // the old column (here the removed line 5's cell, then a context line's old side) keeps the last line
            await moveTo(fileEl().querySelector('.half[data-o="5"]'));
            await moveTo(fileEl().querySelector('.half[data-o="6"]'));
            expect(cells()).toEqual([4, 5, 6]);
            await moveTo(cell(8));
            expect(cells()).toEqual([4, 5, 6, 7, 8]);
            expect(fileEl().querySelectorAll('.half.in-range[data-o]')).toHaveLength(0);
            await release(cell(8));
            expect(page.composer).toMatchObject({ line: 8, startLine: 4 });
            expect(cells()).toEqual([4, 5, 6, 7, 8]);
        } finally {
            page.view = 'unified';
        }
    });
});
