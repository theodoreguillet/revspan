// Has the element come near the viewport? Becomes true once and stays true (work started there is kept).
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/** Margin around the viewport: the work starts a little before the element shows up. */
const MARGIN = '600px 0px';

export function useNearViewport(el: Readonly<Ref<HTMLElement | null>>): Readonly<Ref<boolean>> {
    const near = ref(false);
    let observer: IntersectionObserver | null = null;
    onMounted(() => {
        // without IntersectionObserver nothing is ever "near": the code stays plain
        if (!el.value || typeof IntersectionObserver === 'undefined') {
            return;
        }
        observer = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) {
                near.value = true;
                observer?.disconnect();
                observer = null;
            }
        // root: document, not the implicit root: a cross-origin iframe (VS Code webview) ignores the margin otherwise
        }, { root: document, rootMargin: MARGIN });
        observer.observe(el.value);
    });
    onBeforeUnmount(() => observer?.disconnect());
    return near;
}
