// Navigation under the sticky timeline: components declare their elements (files, tabs, threads),
// this module scrolls to them and tracks the current file. No lookup by CSS selector.
import { ref } from 'vue';

export interface ThreadEntry {
    threadId: number;
    /** Thread shown in the diff (not in the Discussions tab). */
    inDiff: boolean;
}

/** Scrolls to place el at `offset` px from the top of the window. */
function scrollToElement(el: Element, offset: number): void {
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset });
}

/** Briefly highlights an element (thread reached by keyboard, "View in diff"). */
function flash(el: HTMLElement): void {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
}

const isVisible = (el: HTMLElement): boolean => el.offsetParent !== null;

export function useDiffNav() {
    /** Height of the sticky timeline (measured by Timeline). */
    const tlHeight = ref(0);
    /** Index of the current file in the diff list. */
    const curFile = ref(0);
    const files = new Map<string, HTMLElement>();
    const threads = new Map<HTMLElement, ThreadEntry>();
    let tabs: HTMLElement | null = null;

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

    function scrollToFile(path: string): void {
        const el = files.get(path);
        if (el) {
            scrollToElement(el, tlHeight.value + 6);
        }
    }

    /** A file that was just collapsed must not leave the page lower than it. */
    function keepFileInView(path: string): void {
        const el = files.get(path);
        if (el && el.getBoundingClientRect().top < tlHeight.value) {
            scrollToElement(el, tlHeight.value + 6);
        }
    }

    /** After a range change: scrolls back to the top of the tabs if we were reading further down. */
    function scrollToTabsIfBelow(): void {
        if (!tabs) {
            return;
        }
        const top = tabs.getBoundingClientRect().top + window.scrollY - tlHeight.value;
        if (window.scrollY > top) {
            window.scrollTo({ top });
        }
    }

    /** Index (in `paths`) of the last file whose header went under the timeline. */
    function fileUnderTimeline(paths: string[]): number {
        const limit = tlHeight.value + 48;
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
        const y = tlHeight.value + 60;
        const ordered = [...threads.keys()]
            .filter(isVisible)
            .map((el) => ({ el, top: el.getBoundingClientRect().top }))
            .sort((a, b) => a.top - b.top);
        const target = dir > 0 ? ordered.find((t) => t.top > y + 2) : ordered.reverse().find((t) => t.top < y - 2);
        if (target) {
            window.scrollBy({ top: target.top - y });
            flash(target.el);
        }
    }

    /** Scrolls to the thread in the diff and highlights it. */
    function revealThread(threadId: number): void {
        for (const [el, entry] of threads) {
            if (entry.inDiff && entry.threadId === threadId) {
                scrollToElement(el, tlHeight.value + 60);
                flash(el);
                return;
            }
        }
    }

    return {
        tlHeight, curFile,
        registerFile, registerTabs, registerThread, unregisterThread,
        scrollToFile, keepFileInView, scrollToTabsIfBelow, fileUnderTimeline, nextThread, revealThread,
    };
}
