// Height of a sticky bar, measured while it is mounted: the sticky elements below it (file headers, file list)
// read the CSS variable, the scroll offsets read the value. Back to 0 when the bar goes away.
import { onBeforeUnmount, onMounted, type Ref } from 'vue';

export function useStickyHeight(el: Readonly<Ref<HTMLElement | null>>, cssVar: string, set: (height: number) => void): void {
    let observer: ResizeObserver | null = null;
    onMounted(() => {
        if (!el.value || typeof ResizeObserver === 'undefined') {
            return;
        }
        observer = new ResizeObserver(() => {
            const height = el.value?.offsetHeight ?? 0;
            set(height);
            document.documentElement.style.setProperty(cssVar, `${height}px`);
        });
        observer.observe(el.value);
    });
    onBeforeUnmount(() => {
        observer?.disconnect();
        set(0);
        document.documentElement.style.removeProperty(cssVar);
    });
}
