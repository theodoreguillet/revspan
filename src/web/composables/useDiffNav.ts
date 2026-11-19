// Navigation under the sticky timeline: components declare their elements (files, tabs, threads),
// this module scrolls to them and tracks the current file. No lookup by CSS selector.
import { computed, ref } from 'vue';

export interface ThreadEntry {
    threadId: number;
    /** Thread shown in the diff (not in the Discussions tab). */
    inDiff: boolean;
}

/** Frames during which a scroll is corrected (blocks rendered as they come into view settle in two or three). */
const SETTLE_FRAMES = 8;
/** Time during which the scroll of a file reached by j/k/v settles: scroll events then never move the current file. */
const PIN_SETTLE_MS = 400;
/** The latest scroll: a new one, or the user scrolling by hand, stops correcting the previous one. */
let lastScroll = 0;
let listening = false;

/** The user takes over (wheel, touch, keyboard, click): the scroll set by the page is no longer corrected. */
function stopCorrectingOnInput(): void {
    if (listening || typeof window === 'undefined') {
        return;
    }
    listening = true;
    const stop = (): void => {
        lastScroll++;
    };
    for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
        window.addEventListener(type, stop, { capture: true, passive: true });
    }
}

/**
 * Scrolls to place el at `offset` px from the top of the window. The browser renders the diff blocks only once they
 * come near the window (content-visibility), at their real height instead of an estimate: while el moves over the next
 * frames, the scroll is set again (not when it only stays short of the place, at the end of the page).
 */
function scrollToElement(el: Element, offset: number): void {
    stopCorrectingOnInput();
    const place = (): number => {
        window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset });
        return el.getBoundingClientRect().top;
    };
    let last = place();
    const id = ++lastScroll;
    let frames = 0;
    const settle = (): void => {
        if (id !== lastScroll || !el.isConnected || ++frames > SETTLE_FRAMES) {
            return;
        }
        const top = el.getBoundingClientRect().top;
        last = Math.abs(top - last) > 1 && Math.abs(top - offset) > 1 ? place() : top;
        requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
}

/** Briefly highlights an element (thread reached by keyboard, "View in diff", line reached by go to definition). */
function flash(el: HTMLElement): void {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
}

const isVisible = (el: HTMLElement): boolean => el.offsetParent !== null;

export function useDiffNav() {
    /** Height of the sticky timeline (measured by Timeline). */
    const tlHeight = ref(0);
    /** Height of the sticky diff toolbar, stuck under the timeline (measured by DiffToolbar; 0 outside the Diff tab). */
    const toolbarHeight = ref(0);
    /** What the sticky bars cover at the top of the window: the diff content is read below it. */
    const stickyHeight = computed(() => tlHeight.value + toolbarHeight.value);
    /** Index of the current file in the diff list. */
    const curFile = ref(0);
    const files = new Map<string, HTMLElement>();
    const threads = new Map<HTMLElement, ThreadEntry>();
    let tabs: HTMLElement | null = null;
    /** Line of the current search match (the last one rendered as current). */
    let match: HTMLElement | null = null;
    /** Line to reach by go to definition (or back), registered when its block renders it; null once revealed. */
    let jump: HTMLElement | null = null;

    /**
     * File reached by j/k/v: while its scroll settles (the page re-lays out as files collapse, and it may stop short of
     * the place at the end of the page) the scroll position says another file, so the scroll does not move `curFile`
     * back. Then it stays pinned until the scroll moves away from where it settled (`y`: the place after the scroll,
     * refreshed while it settles). Any other scroll set by the page (thread, search match, definition, tabs) releases it.
     */
    let pin: { until: number; y: number } | null = null;

    /** Pins `curFile` (just set to the file reached) before the scroll to it. */
    function pinFile(): void {
        pin = { until: performance.now() + PIN_SETTLE_MS, y: window.scrollY };
    }

    /** On a scroll event: whether `curFile` stays as is (a pinned file settling, or not scrolled away from). */
    function pinHolds(): boolean {
        if (!pin) {
            return false;
        }
        if (performance.now() < pin.until) {
            pin.y = window.scrollY;
            return true;
        }
        if (Math.abs(window.scrollY - pin.y) <= 1) {
            return true;
        }
        pin = null;
        return false;
    }

    /** A scroll set by the page to something else than the pinned file: the scroll drives `curFile` again. */
    function scrollAway(el: Element, offset: number): void {
        pin = null;
        scrollToElement(el, offset);
    }

    function registerFile(path: string, el: HTMLElement | null): void {
        if (el) {
            files.set(path, el);
        } else {
            files.delete(path);
        }
    }

    function registerTabs(el: HTMLElement | null): void {
        tabs = el;
    }

    function registerThread(el: HTMLElement, entry: ThreadEntry): void {
        threads.set(el, entry);
    }

    function unregisterThread(el: HTMLElement): void {
        threads.delete(el);
    }

    function registerMatch(el: unknown): void {
        if (el instanceof HTMLElement) {
            match = el;
        }
    }

    /** Vue also calls a ref with null when the line loses it (another line became the target): ignored. */
    function registerJump(el: unknown): void {
        if (el instanceof HTMLElement) {
            jump = el;
        }
    }

    /** Before a new jump: a line that fails to render never reveals the previous one. */
    function clearJump(): void {
        jump = null;
    }

    /**
     * Scrolls the registered jump line under the sticky bars and the sticky file header (or `top` px from the top of the
     * window: back to a saved place) and flashes it. Returns it, or null if no line is registered.
     */
    function revealJump(top?: number): HTMLElement | null {
        const el = jump;
        jump = null;
        if (!el?.isConnected) {
            return null;
        }
        scrollAway(el, top === undefined ? stickyHeight.value + 60 : Math.max(top, stickyHeight.value));
        flash(el);
        return el;
    }

    /** Scrolls the line of the current search match under the sticky bars and the sticky file header. */
    function scrollToMatch(): void {
        if (match?.isConnected) {
            scrollAway(match, stickyHeight.value + 60);
        }
    }

    /** Scrolls a file under the sticky bars; a pin (pinFile) then holds from where this scroll left the page. */
    function scrollToFile(path: string): void {
        const el = files.get(path);
        if (el) {
            scrollToElement(el, stickyHeight.value + 6);
        }
        if (pin) {
            pin.y = window.scrollY;
        }
    }

    /** A file that was just collapsed must not leave the page lower than it. */
    function keepFileInView(path: string): void {
        const el = files.get(path);
        if (el && el.getBoundingClientRect().top < stickyHeight.value) {
            scrollToElement(el, stickyHeight.value + 6);
        }
    }

    /** After a range change: scrolls back to the top of the tabs if we were reading further down.
     *  The tabs are above the diff toolbar, which is not stuck yet there: only the timeline covers them. */
    function scrollToTabsIfBelow(): void {
        if (!tabs) {
            return;
        }
        const top = tabs.getBoundingClientRect().top + window.scrollY - tlHeight.value;
        if (window.scrollY > top) {
            pin = null;
            window.scrollTo({ top });
        }
    }

    /** Index (in `paths`) of the last file whose header went under the sticky bars. */
    function fileUnderTimeline(paths: string[]): number {
        const limit = stickyHeight.value + 48;
        let cur = 0;
        paths.forEach((path, idx) => {
            const el = files.get(path);
            if (el && el.getBoundingClientRect().top <= limit) {
                cur = idx;
            }
        });
        return cur;
    }

    /** Next (1) or previous (-1) thread relative to the reading line, below the sticky headers. */
    function nextThread(dir: 1 | -1): void {
        const y = stickyHeight.value + 60;
        const ordered = [...threads.keys()]
            .filter(isVisible)
            .map((el) => ({ el, top: el.getBoundingClientRect().top }))
            .sort((a, b) => a.top - b.top);
        const target = dir > 0 ? ordered.find((t) => t.top > y + 2) : ordered.reverse().find((t) => t.top < y - 2);
        if (target) {
            scrollAway(target.el, y);
            flash(target.el);
        }
    }

    /** Scrolls to the thread in the diff and highlights it. */
    function revealThread(threadId: number): void {
        for (const [el, entry] of threads) {
            if (entry.inDiff && entry.threadId === threadId) {
                scrollAway(el, stickyHeight.value + 60);
                flash(el);
                return;
            }
        }
    }

    return {
        tlHeight, toolbarHeight, stickyHeight, curFile,
        registerFile, registerTabs, registerThread, unregisterThread, registerMatch, registerJump, clearJump, pinFile, pinHolds,
        scrollToFile, scrollToMatch, revealJump, keepFileInView, scrollToTabsIfBelow, fileUnderTimeline, nextThread, revealThread,
    };
}
