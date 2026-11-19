// Drag on a line's "+" to comment a range of lines, like Bitbucket: press the "+" of a new-side line, move over other
// lines of the file (the page scrolls while the pointer is near the top or bottom edge), release: the composer opens
// for the lines in between, as a click on the first "+" then a Shift+click on the other would. Released on the line
// pressed: that line alone, as a click. Escape, a release outside the window, a cancelled pointer or the window losing
// the focus cancel it. The line under the pointer is read from the rows on screen (their `data-n`), once per frame:
// nothing is measured nor rendered for each pointer move.
import { onScopeDispose, shallowRef } from 'vue';
import type { ComposerTarget } from '../lib/diff.ts';
import { dragSpan, edgeScrollStep, edgeSpeed, hoveredLine, reachedLine, type Band, type LineSpan } from '../lib/range-drag.ts';

/** Lines being selected by a drag, in a file. */
export interface DragRange extends LineSpan {
    path: string;
}

export interface RangeDragHost {
    /** Opens the composer on the line pressed (`end` null), or on the range from it to `end`. */
    open: (anchor: ComposerTarget, end: ComposerTarget | null) => void;
    /** Target of the "+" of new-side line `line` of a file (null when it is not shown any more). */
    targetAt: (path: string, line: number) => ComposerTarget | null;
    /** Height of the sticky bars at the top of the window. */
    stickyHeight: () => number;
    /** The page scrolls by itself: a file reached by j/k/v no longer holds the current file. */
    releasePin: () => void;
}

interface Drag {
    anchor: ComposerTarget;
    /** The file's block, and the height of its sticky header: the lines show under the bars and that header. */
    file: Element;
    header: number;
    /** Horizontal extent of the line pressed: the line under the pointer is read there (side by side: the new column). */
    left: number;
    right: number;
    /** Last pointer position (window coordinates). */
    x: number;
    y: number;
    /** Line reached, and whether the pointer has left the line pressed once (the range shows from then on). */
    line: number;
    moved: boolean;
    /** The line under the pointer may have changed (pointer moved, page scrolled): read it on the next frame. */
    stale: boolean;
    frame: number;
    /** Time of the previous frame (null before the first one). */
    time: number | null;
}

/** On the root element during a drag: no text selected (app.css). */
const DRAG_CLASS = 'rv-range-drag';
/** Nominal frame length (ms), for the first frame of a drag. */
const FRAME_MS = 16;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export function useRangeDrag(host: RangeDragHost) {
    /** Lines being selected (null: no drag, or the pointer has not left the line pressed yet). */
    const range = shallowRef<DragRange | null>(null);
    let drag: Drag | null = null;
    /** The click that follows a release: the release already opened the composer. */
    let releasedClick = false;

    /** The band where the file's lines are read: under the sticky bars and the file header, above the window's bottom. */
    const viewOf = (d: Drag): Band => ({ top: host.stickyHeight() + d.header, bottom: window.innerHeight });

    /** Reads the line under the pointer (within the band: over the bars, the first line under them). */
    function sample(d: Drag): void {
        d.stale = false;
        const view = viewOf(d);
        const x = d.right - d.left > 2 ? clamp(d.x, d.left + 1, d.right - 1) : d.x;
        const y = view.bottom - view.top > 2 ? clamp(d.y, view.top + 1, view.bottom - 1) : d.y;
        const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-n]') ?? null;
        const line = reachedLine(d.line, hoveredLine(row?.dataset.n, !!row && row.closest('.rv-file') === d.file));
        if (line !== d.line) {
            d.line = line;
            d.moved = true;
        }
        if (d.moved) {
            const shown = range.value;
            const span = dragSpan(d.anchor.line, d.line);
            if (shown?.first !== span.first || shown.last !== span.last) {
                range.value = { path: d.anchor.path, ...span };
            }
        }
    }

    /** Each frame: scrolls the page while the pointer is near an edge, then reads the line under it if needed. */
    function tick(time: number): void {
        const d = drag;
        if (!d) {
            return;
        }
        if (!d.file.isConnected) {
            stop();
            return;
        }
        const ms = d.time === null ? FRAME_MS : time - d.time;
        d.time = time;
        const view = viewOf(d);
        const speed = edgeSpeed(d.y, view);
        if (speed) {
            const box = d.file.getBoundingClientRect();
            const step = edgeScrollStep(speed, ms, view, { top: box.top + d.header, bottom: box.bottom });
            if (step) {
                window.scrollBy(0, step);
                host.releasePin();
                d.stale = true;
            }
        }
        if (d.stale) {
            sample(d);
        }
        d.frame = requestAnimationFrame(tick);
    }

    const onMove = (event: PointerEvent): void => {
        const d = drag;
        if (!d || event.pointerType !== 'mouse') {
            return;
        }
        // released where the page could not see it (outside a webview): nothing to open
        if (!(event.buttons & 1)) {
            stop();
            return;
        }
        d.x = event.clientX;
        d.y = event.clientY;
        d.stale = true;
    };

    const onUp = (event: PointerEvent): void => {
        const d = drag;
        if (!d || event.button !== 0) {
            return;
        }
        const outside = event.clientX < 0 || event.clientY < 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
        if (!outside) {
            d.x = event.clientX;
            d.y = event.clientY;
            sample(d);
        }
        stop();
        if (outside) {
            return;
        }
        releasedClick = true;
        setTimeout(() => {
            releasedClick = false;
        }, 0);
        if (d.line === d.anchor.line) {
            host.open(d.anchor, null);
            return;
        }
        const end = host.targetAt(d.anchor.path, d.line);
        if (end) {
            host.open(d.anchor, end);
        }
    };

    const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            // the drag only: the composer, the shortcuts and the page do not see this Escape
            event.preventDefault();
            event.stopImmediatePropagation();
            stop();
        }
    };

    const onScroll = (): void => {
        if (drag) {
            drag.stale = true;
        }
    };

    const listeners: [string, EventListener, AddEventListenerOptions][] = [
        ['pointermove', onMove as EventListener, { passive: true }],
        ['pointerup', onUp as EventListener, {}],
        ['pointercancel', () => stop(), {}],
        ['keydown', onKey as EventListener, { capture: true }],
        ['blur', () => stop(), {}],
        ['scroll', onScroll, { passive: true }],
    ];

    /** Ends the drag (released or cancelled): nothing marked, no listener left, text selectable again. */
    function stop(): void {
        const d = drag;
        if (!d) {
            return;
        }
        drag = null;
        cancelAnimationFrame(d.frame);
        for (const [type, listener, options] of listeners) {
            window.removeEventListener(type, listener, options);
        }
        document.documentElement.classList.remove(DRAG_CLASS);
        range.value = null;
    }

    /**
     * Pointer pressed on the "+" of `target`. Starts a drag for the primary mouse button without modifier on a new-side
     * line; otherwise nothing changes (Shift+click, a click with a modifier, a touch, a removed line: the click decides).
     */
    function start(event: PointerEvent, target: ComposerTarget): void {
        stop();
        releasedClick = false;
        const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (event.button !== 0 || event.pointerType !== 'mouse' || !plain || target.kind !== 'new') {
            return;
        }
        const pressed = (event.currentTarget ?? event.target) as Element | null;
        const row = pressed?.closest?.('[data-n]');
        const file = row?.closest('.rv-file');
        if (!row || !file) {
            return;
        }
        const box = row.getBoundingClientRect();
        drag = {
            anchor: target, file, header: file.querySelector('.rv-fh')?.getBoundingClientRect().height ?? 0, left: box.left, right: box.right,
            x: event.clientX, y: event.clientY, line: target.line, moved: false, stale: false, frame: 0, time: null,
        };
        for (const [type, listener, options] of listeners) {
            window.addEventListener(type, listener, options);
        }
        document.documentElement.classList.add(DRAG_CLASS);
        drag.frame = requestAnimationFrame(tick);
    }

    /** True once for the click that follows a release (the release opened the composer): the "+" ignores it. */
    function takeReleasedClick(): boolean {
        const was = releasedClick;
        releasedClick = false;
        return was;
    }

    onScopeDispose(stop);

    return { range, start, takeReleasedClick };
}
