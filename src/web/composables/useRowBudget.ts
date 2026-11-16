// Progressive rendering of the diff, so that showing a large file or changing every file at once (context, range)
// never blocks the page: a file renders its first lines (all of them when small) if it is on screen, the rest comes
// over the next frames, ROWS_PER_FRAME lines per frame for all the files together, the closest to the window first.
import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { initialRowBudget, nextRowBudget, ROWS_PER_FRAME, viewportDistance } from '../lib/diff.ts';

/** A file still rendering: its distance to the window, and what it does with `rows` more lines (returns those used). */
interface Grower {
    distance: () => number;
    grow: (rows: number) => number;
}

const growers = new Set<Grower>();
let frame = 0;

function tick(): void {
    frame = 0;
    let left = ROWS_PER_FRAME;
    const order = [...growers].map((grower) => ({ grower, distance: grower.distance() })).sort((a, b) => a.distance - b.distance);
    for (const { grower } of order) {
        if (left <= 0) {
            break;
        }
        left -= grower.grow(left);
    }
    if (growers.size) {
        frame = requestAnimationFrame(tick);
    }
}

function start(grower: Grower): void {
    growers.add(grower);
    frame ||= requestAnimationFrame(tick);
}

function stop(grower: Grower): void {
    growers.delete(grower);
    if (!growers.size && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
    }
}

/**
 * Number of lines of the file to render (Infinity: all). Starts again when the file is expanded or its content
 * changes: on screen, its first lines at once; off screen, none until its turn.
 */
export function useRowBudget(el: Readonly<Ref<HTMLElement | null>>, totalLines: () => number, shown: () => boolean, content: () => unknown): Readonly<Ref<number>> {
    // first render: as if on screen (the page is being built, nothing to compare with)
    const budget = ref(initialRowBudget(totalLines(), true));
    const grower: Grower = {
        distance: () => {
            const rect = el.value?.isConnected ? el.value.getBoundingClientRect() : null;
            return rect ? viewportDistance(rect.top, rect.height, window.innerHeight) : Infinity;
        },
        grow: (rows) => {
            const before = budget.value;
            budget.value = nextRowBudget(before, rows, totalLines());
            if (budget.value === Infinity) {
                stop(grower);
                return totalLines() - before;
            }
            return rows;
        },
    };

    watch([shown, content], ([isShown], previous) => {
        stop(grower);
        // the layout read here is the one on screen (before this change renders)
        budget.value = initialRowBudget(totalLines(), !previous || grower.distance() === 0);
        if (isShown && budget.value !== Infinity) {
            start(grower);
        }
    }, { immediate: true });
    onBeforeUnmount(() => stop(grower));
    return budget;
}
