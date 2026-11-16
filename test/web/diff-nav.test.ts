import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDiffNav } from '../../src/web/composables/useDiffNav.ts';

/** Element whose top is at `top` px from the top of the window. */
function at(top: number): HTMLElement {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 0, right: 100, width: 100, height: 30, x: 0, y: top, toJSON: () => ({}) });
    return el;
}

function nav(tl: number, toolbar: number) {
    const n = useDiffNav();
    n.tlHeight.value = tl;
    n.toolbarHeight.value = toolbar;
    return n;
}

describe('diff navigation under the sticky timeline and diff toolbar', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reads the diff below both bars', () => {
        expect(nav(150, 40).stickyHeight.value).toBe(190);
        expect(nav(150, 0).stickyHeight.value).toBe(150);
    });

    it('j/k: the file lands just under the toolbar, not behind it', () => {
        const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
        const n = nav(150, 40);
        n.registerFile('a.ts', at(800));
        n.scrollToFile('a.ts');
        expect(scroll).toHaveBeenCalledWith({ top: window.scrollY + 800 - 196 });
    });

    it('j/k: scrolls again while the blocks rendered on the way move the file', async () => {
        let top = 800;
        // the window scrolls where asked: the file lands under the toolbar
        const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {
            top = 196;
        });
        const n = nav(150, 40);
        const file = at(0);
        file.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 0, right: 100, width: 100, height: 30, x: 0, y: top, toJSON: () => ({}) });
        document.body.append(file);
        n.registerFile('a.ts', file);
        n.scrollToFile('a.ts');
        expect(scroll).toHaveBeenCalledTimes(1);
        // then a block above it renders 300 px taller than estimated: scrolled again, once
        top = 196 + 300;
        for (let k = 0; k < 4; k++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        expect(scroll).toHaveBeenCalledTimes(2);
        expect(scroll).toHaveBeenLastCalledWith({ top: window.scrollY + 300 });
        file.remove();
    });

    it('j/k: no new scroll when the file stays short of its place (end of the page) or once the user scrolls', async () => {
        const frames = async (count: number): Promise<void> => {
            for (let k = 0; k < count; k++) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
        };
        let top = 800;
        const file = at(0);
        file.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 0, right: 100, width: 100, height: 30, x: 0, y: top, toJSON: () => ({}) });
        document.body.append(file);
        const n = nav(150, 40);
        n.registerFile('a.ts', file);
        // end of the page: the window cannot go further, the file stays at 500 px
        const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {
            top = 500;
        });
        n.scrollToFile('a.ts');
        await frames(4);
        expect(scroll).toHaveBeenCalledTimes(1);
        // the user turns the wheel: a block rendered above then moves the file, the page leaves it alone
        top = 800;
        scroll.mockImplementation(() => {
            top = 196;
        });
        n.scrollToFile('a.ts');
        window.dispatchEvent(new Event('wheel'));
        top = 496;
        await frames(4);
        expect(scroll).toHaveBeenCalledTimes(2);
        file.remove();
    });

    it('current file: a header hidden by the toolbar counts as passed, one below it does not yet', () => {
        const n = nav(150, 40);
        n.registerFile('a.ts', at(-400));
        n.registerFile('b.ts', at(230));
        n.registerFile('c.ts', at(260));
        expect(n.fileUnderTimeline(['a.ts', 'b.ts', 'c.ts'])).toBe(1);
        n.toolbarHeight.value = 0;
        expect(n.fileUnderTimeline(['a.ts', 'b.ts', 'c.ts'])).toBe(0);
    });

    it('a collapsed file whose top went behind the toolbar is brought back under it', () => {
        const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
        const n = nav(150, 40);
        n.registerFile('a.ts', at(170));
        n.keepFileInView('a.ts');
        expect(scroll).toHaveBeenCalledWith({ top: window.scrollY + 170 - 196 });
        scroll.mockClear();
        n.registerFile('b.ts', at(200));
        n.keepFileInView('b.ts');
        expect(scroll).not.toHaveBeenCalled();
    });

    it('the tabs, above the toolbar, only go under the timeline', () => {
        const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
        vi.spyOn(window, 'scrollY', 'get').mockReturnValue(2000);
        const n = nav(150, 40);
        n.registerTabs(at(-500));
        n.scrollToTabsIfBelow();
        expect(scroll).toHaveBeenCalledWith({ top: 2000 - 500 - 150 });
    });
});
