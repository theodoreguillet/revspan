import { describe, expect, it } from 'vitest';
import type { DiffLine, FileDiff } from '../../src/shared/api.ts';
import { composerTargetFor } from '../../src/web/lib/diff.ts';
import {
    armsDrag, clipSpan, dragSpan, EDGE_MAX_SPEED, EDGE_MIN_SPEED, EDGE_ZONE_PX, edgeScrollStep, edgeSpeed, hoveredLine, inSpan, MAX_FRAME_MS, newLinesSpan, newLineTarget,
    reachedLine, spanKey,
} from '../../src/web/lib/range-drag.ts';

const line = (t: DiffLine['t'], o: number | null, n: number | null, text = ''): DiffLine => ({ t, o, n, text, hl: [] });

describe('drag on a "+": the line under the pointer and the range it makes', () => {
    it('the line under the pointer is the new-side number of its row in the same file', () => {
        expect(hoveredLine('7', true)).toBe(7);
        // a removed line (unified: data-n=""), an old-side cell or anything else without data-n (side by side, hunk
        // header, gap between hunks, thread, composer, sticky bars)
        expect(hoveredLine('', true)).toBeNull();
        expect(hoveredLine(undefined, true)).toBeNull();
        expect(hoveredLine(null, true)).toBeNull();
        // another file
        expect(hoveredLine('7', false)).toBeNull();
        expect(hoveredLine('x', true)).toBeNull();
        expect(hoveredLine('0', true)).toBeNull();
    });

    it('a press is a click until the pointer has moved more than 4 px from where it was pressed', () => {
        const at = { x: 100, y: 300 };
        expect(armsDrag(at, at)).toBe(false);
        expect(armsDrag(at, { x: 104, y: 300 })).toBe(false);
        expect(armsDrag(at, { x: 100, y: 296 })).toBe(false);
        expect(armsDrag(at, { x: 103, y: 302 })).toBe(false);
        expect(armsDrag(at, { x: 105, y: 300 })).toBe(true);
        expect(armsDrag(at, { x: 103, y: 303 })).toBe(true);
        expect(armsDrag(at, { x: 100, y: 280 })).toBe(true);
    });

    it('the range keeps the last new-side line reached while the pointer is elsewhere', () => {
        expect(reachedLine(4, 9)).toBe(9);
        expect(reachedLine(9, null)).toBe(9);
        expect(reachedLine(9, 2)).toBe(2);
    });

    it('from the line pressed to the line reached, in either order; the line alone when it is the same', () => {
        expect(dragSpan(4, 7)).toEqual({ first: 4, last: 7 });
        expect(dragSpan(7, 4)).toEqual({ first: 4, last: 7 });
        expect(dragSpan(5, 5)).toEqual({ first: 5, last: 5 });
    });

    it('marks new-side lines only (added or context), never a removed one', () => {
        const span = { first: 4, last: 7 };
        expect(inSpan(span, line('+', null, 4))).toBe(true);
        expect(inSpan(span, line(' ', 6, 7))).toBe(true);
        expect(inSpan(span, line(' ', 8, 8))).toBe(false);
        expect(inSpan(span, line('+', null, 3))).toBe(false);
        expect(inSpan(span, line('-', 5, null))).toBe(false);
        expect(inSpan(span, null)).toBe(false);
        expect(inSpan(null, line('+', null, 5))).toBe(false);
    });

    it('a block of rows renders again only when the part of the range it shows changes', () => {
        const rows = [line(' ', 10, 12), line('-', 11, null), line('+', null, 13), line('+', null, 14), null];
        expect(newLinesSpan(rows)).toEqual({ first: 12, last: 14 });
        expect(newLinesSpan([line('-', 3, null), null])).toBeNull();
        const block = { first: 12, last: 14 };
        expect(clipSpan({ first: 4, last: 13 }, block)).toEqual({ first: 12, last: 13 });
        expect(clipSpan({ first: 4, last: 30 }, block)).toEqual(block);
        expect(clipSpan({ first: 15, last: 30 }, block)).toBeNull();
        expect(clipSpan(null, block)).toBeNull();
        expect(clipSpan({ first: 4, last: 30 }, null)).toBeNull();
        expect(spanKey({ first: 12, last: 13 })).toBe('12-13');
        expect(spanKey(null)).toBe('');
        // the range growing from 4 to 9, then to 20: a block of lines 12-14 keeps its key until the range reaches it
        const key = (last: number): string => spanKey(clipSpan(dragSpan(4, last), block));
        expect([key(9), key(11), key(12), key(14), key(20)]).toEqual(['', '', '12-12', '12-14', '12-14']);
    });

    it('the composer target of the line reached is that of its "+" (new side), across hunks', () => {
        const file: Pick<FileDiff, 'path' | 'hunks'> = {
            path: 'src/Action.ts',
            hunks: [
                { oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, header: '', lines: [line(' ', 4, 4, 'a'), line('-', 5, null, 'b'), line('+', null, 5, 'c')] },
                { oldStart: 40, oldLines: 1, newStart: 40, newLines: 1, header: '', lines: [line(' ', 40, 40, 'z')] },
            ],
        };
        expect(newLineTarget(file, 5)).toEqual(composerTargetFor('src/Action.ts', line('+', null, 5, 'c'), 'new'));
        expect(newLineTarget(file, 40)).toEqual(composerTargetFor('src/Action.ts', line(' ', 40, 40, 'z'), 'new'));
        // not shown (between hunks, or gone after a new comparison)
        expect(newLineTarget(file, 20)).toBeNull();
        expect(newLineTarget(undefined, 5)).toBeNull();
    });
});

describe('drag on a "+": the page scrolls while the pointer is near an edge', () => {
    // the diff is read between the sticky bars (+ file header) and the bottom of the window
    const view = { top: 190, bottom: 900 };

    it('no scroll away from the edges', () => {
        expect(edgeSpeed(500, view)).toBe(0);
        expect(edgeSpeed(view.top + EDGE_ZONE_PX, view)).toBe(0);
        expect(edgeSpeed(view.bottom - EDGE_ZONE_PX, view)).toBe(0);
    });

    it('up near the top edge, down near the bottom one, faster closer to the edge, fastest at or beyond it', () => {
        const down = [view.bottom - EDGE_ZONE_PX + 1, view.bottom - 30, view.bottom - 10, view.bottom].map((y) => edgeSpeed(y, view));
        expect(down[0]).toBeGreaterThanOrEqual(EDGE_MIN_SPEED);
        expect(down[0]).toBeLessThan(EDGE_MIN_SPEED + 0.01);
        for (let k = 1; k < down.length; k++) {
            expect(down[k]).toBeGreaterThan(down[k - 1]!);
        }
        expect(down[3]).toBe(EDGE_MAX_SPEED);
        // below the window (the button held outside it)
        expect(edgeSpeed(view.bottom + 200, view)).toBe(EDGE_MAX_SPEED);
        // the same upwards, negative
        expect(edgeSpeed(view.top + 10, view)).toBe(-edgeSpeed(view.bottom - 10, view));
        // over the sticky bars or above the window
        expect(edgeSpeed(view.top, view)).toBe(-EDGE_MAX_SPEED);
        expect(edgeSpeed(40, view)).toBe(-EDGE_MAX_SPEED);
        expect(edgeSpeed(-30, view)).toBe(-EDGE_MAX_SPEED);
    });

    it('a short window shrinks both bands so that they never meet', () => {
        const small = { top: 190, bottom: 280 };
        expect(edgeSpeed(235, small)).toBe(0);
        expect(edgeSpeed(195, small)).toBeLessThan(0);
        expect(edgeSpeed(275, small)).toBeGreaterThan(0);
        expect(edgeSpeed(200, { top: 190, bottom: 190 })).toBe(0);
    });

    it('scrolls speed × frame time, at least a pixel, a stalled frame counting as a short one', () => {
        const file = { top: -2000, bottom: 4000 };
        expect(edgeScrollStep(1, 16, view, file)).toBe(16);
        expect(edgeScrollStep(-1, 16, view, file)).toBe(-16);
        expect(edgeScrollStep(0.01, 16, view, file)).toBe(1);
        expect(edgeScrollStep(-0.01, 16, view, file)).toBe(-1);
        expect(edgeScrollStep(1, 1000, view, file)).toBe(MAX_FRAME_MS);
        expect(edgeScrollStep(0, 16, view, file)).toBe(0);
        expect(edgeScrollStep(1, 0, view, file)).toBe(0);
    });

    it('stops at the edges of the file: its last line above the bottom edge, its first line under the top one', () => {
        // down: 10 px of the file left below the window, then none
        expect(edgeScrollStep(1, 16, view, { top: -500, bottom: view.bottom + 10 })).toBe(10);
        expect(edgeScrollStep(1, 16, view, { top: -500, bottom: view.bottom })).toBe(0);
        expect(edgeScrollStep(1, 16, view, { top: -500, bottom: 600 })).toBe(0);
        // up: the first line 5 px under the bars, then right under them
        expect(edgeScrollStep(-1, 16, view, { top: view.top - 5, bottom: 3000 })).toBe(-5);
        expect(edgeScrollStep(-1, 16, view, { top: view.top, bottom: 3000 })).toBe(0);
        expect(edgeScrollStep(-1, 16, view, { top: 400, bottom: 3000 })).toBe(0);
    });
});
