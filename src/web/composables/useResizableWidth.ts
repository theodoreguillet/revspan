// Width of the file list, set by dragging its right edge (like the VS Code sidebar) and remembered locally.
// null = default width (from the stylesheet, which adapts to narrow screens).
import { computed, ref, type Ref } from 'vue';
import { useLocalPref } from './useLocalPref.ts';

export const MIN_FILES_WIDTH = 180;
const KEY_STEP = 16;

/** Keeps a width between the minimum and half of the viewport. */
export function clampFilesWidth(px: number, viewportWidth: number): number {
    return Math.round(Math.min(Math.max(px, MIN_FILES_WIDTH), Math.max(MIN_FILES_WIDTH, viewportWidth / 2)));
}

const isWidth = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);

export function useResizableWidth(panel: Ref<HTMLElement | null>) {
    const width = useLocalPref<number | null>('filesWidth', null, isWidth);
    const dragging = ref(false);
    const style = computed(() => (width.value === null ? {} : { width: `${width.value}px` }));

    const currentWidth = (): number => panel.value?.getBoundingClientRect().width ?? MIN_FILES_WIDTH;
    const setWidth = (px: number): void => {
        width.value = clampFilesWidth(px, window.innerWidth);
    };

    function startDrag(event: PointerEvent): void {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        const handle = event.currentTarget as HTMLElement;
        const startX = event.clientX;
        const startWidth = currentWidth();
        const move = (e: PointerEvent): void => setWidth(startWidth + e.clientX - startX);
        const end = (): void => {
            dragging.value = false;
            document.documentElement.classList.remove('rv-resizing');
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', end);
            handle.removeEventListener('pointercancel', end);
        };
        handle.setPointerCapture?.(event.pointerId);
        dragging.value = true;
        document.documentElement.classList.add('rv-resizing');
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    function onKey(event: KeyboardEvent): void {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            setWidth(currentWidth() + (event.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP));
        }
    }

    function reset(): void {
        width.value = null;
    }

    return { width, dragging, style, startDrag, onKey, reset };
}
