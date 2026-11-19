// Drag on a line's "+" to select a range of lines (like Bitbucket): the line under the pointer, the range it makes
// with the line pressed, what each block of rows shows of it, and how fast the page scrolls near an edge.
import type { DiffLine, FileDiff } from '../../shared/api.ts';
import { composerTargetFor, type ComposerTarget } from './diff.ts';

/** New-side lines from `first` to `last` (inclusive, first <= last). */
export interface LineSpan {
    first: number;
    last: number;
}

/** A vertical band of the window (px from its top). */
export interface Band {
    top: number;
    bottom: number;
}

/** Distance (px) the pointer moves from where it was pressed before a press becomes a drag (below: a click). */
export const ARM_PX = 4;
/** Height (px) of the bands along the top and bottom edges where a drag scrolls the page. */
export const EDGE_ZONE_PX = 48;
/** Scroll speed (px per ms) as the pointer enters a band, and at (or beyond) the edge. */
export const EDGE_MIN_SPEED = 0.1;
export const EDGE_MAX_SPEED = 1.5;
/** Longest frame counted (ms): a stalled frame does not make the page jump. */
export const MAX_FRAME_MS = 50;

/**
 * A press on a "+" becomes a drag once the pointer is more than ARM_PX from where it was pressed. Until then it is a
 * click: a "+" pressed near an edge (a search match or a definition lands just under the bars) must not scroll the page
 * nor select other lines.
 */
export function armsDrag(pressed: { x: number; y: number }, at: { x: number; y: number }): boolean {
    return Math.hypot(at.x - pressed.x, at.y - pressed.y) > ARM_PX;
}

/**
 * New-side line of the row under the pointer, from its `data-n` (a unified line, or the new cell side by side). null
 * when it is not a new-side line of the file being commented: a removed line (empty `data-n`), an old-side cell, a hunk
 * header, a gap between hunks, a thread, the composer, the sticky bars (no `data-n`) or another file.
 */
export function hoveredLine(dataN: string | null | undefined, sameFile: boolean): number | null {
    if (!sameFile || !dataN) {
        return null;
    }
    const n = Number(dataN);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** The line a drag reaches: the new-side line under the pointer, or the last one reached while it is elsewhere. */
export function reachedLine(last: number, hovered: number | null): number {
    return hovered ?? last;
}

/** Lines between the line pressed and the line reached, in either order. */
export function dragSpan(anchor: number, line: number): LineSpan {
    return { first: Math.min(anchor, line), last: Math.max(anchor, line) };
}

/** The new-side `line` is in the span (a removed line never is). */
export function inSpan(span: LineSpan | null, line: DiffLine | null): boolean {
    return !!span && !!line && line.t !== '-' && line.n != null && line.n >= span.first && line.n <= span.last;
}

/** First and last new-side lines among `lines` (rows of a block or a hunk; null cells allowed), null if none. */
export function newLinesSpan(lines: readonly (DiffLine | null)[]): LineSpan | null {
    let span: LineSpan | null = null;
    for (const line of lines) {
        if (line && line.t !== '-' && line.n != null) {
            span = span ? { first: Math.min(span.first, line.n), last: Math.max(span.last, line.n) } : { first: line.n, last: line.n };
        }
    }
    return span;
}

/** The part of `span` within `within`, null when they do not meet. */
export function clipSpan(span: LineSpan | null, within: LineSpan | null): LineSpan | null {
    if (!span || !within) {
        return null;
    }
    const first = Math.max(span.first, within.first);
    const last = Math.min(span.last, within.last);
    return first <= last ? { first, last } : null;
}

/** Memo key of a span ('' for none): a block of rows renders again only when the part of the range it shows changes. */
export function spanKey(span: LineSpan | null): string {
    return span ? `${span.first}-${span.last}` : '';
}

/** Composer target of the "+" of new-side line `n` of the file (null when it is not shown). */
export function newLineTarget(file: Pick<FileDiff, 'path' | 'hunks'> | undefined, n: number): ComposerTarget | null {
    for (const hunk of file?.hunks ?? []) {
        const line = hunk.lines.find((l) => l.t !== '-' && l.n === n);
        if (line) {
            return composerTargetFor(file!.path, line, 'new');
        }
    }
    return null;
}

const speedAt = (closeness: number): number => EDGE_MIN_SPEED + (EDGE_MAX_SPEED - EDGE_MIN_SPEED) * closeness * closeness;

/**
 * Scroll speed (px per ms) for a pointer at `y`, the diff being read between `view.top` (under the sticky bars) and
 * `view.bottom`: negative (up) in the band under the top edge, positive (down) in the band over the bottom one, 0
 * elsewhere. It grows as the pointer nears the edge, the most at the edge or beyond it (over the bars, out of the
 * window). A short window gets narrower bands, so that they never meet.
 */
export function edgeSpeed(y: number, view: Band, zone = EDGE_ZONE_PX): number {
    const band = Math.min(zone, (view.bottom - view.top) / 3);
    if (band <= 0) {
        return 0;
    }
    const up = view.top + band - y;
    if (up > 0) {
        return -speedAt(Math.min(1, up / band));
    }
    const down = y - (view.bottom - band);
    return down > 0 ? speedAt(Math.min(1, down / band)) : 0;
}

/**
 * Pixels to scroll for a frame of `ms` at `speed` (at least one), stopped at the edges of the file's lines
 * (`content`): never further down once its last line shows above `view.bottom`, never further up once its first line
 * shows under `view.top`. The browser stops it at the ends of the page.
 */
export function edgeScrollStep(speed: number, ms: number, view: Band, content: Band): number {
    if (!speed || ms <= 0) {
        return 0;
    }
    const px = speed * Math.min(ms, MAX_FRAME_MS);
    if (px > 0) {
        return Math.max(0, Math.min(Math.max(1, Math.round(px)), content.bottom - view.bottom));
    }
    return Math.min(0, Math.max(Math.min(-1, Math.round(px)), content.top - view.top));
}
