// Is the page seen? The browser tab is visible and, in VS Code, the Revspan panel too (a hidden panel kept alive by
// retainContextWhenHidden still reports "visible" to the document; the host tells it apart).
import { computed, ref, type Ref } from 'vue';

const hostVisible = ref(true);
const documentVisible = ref(typeof document === 'undefined' || document.visibilityState === 'visible');
let listening = false;

/** Visibility of the host panel (VS Code), true outside VS Code. */
export function setHostVisible(v: boolean): void {
    hostVisible.value = v;
}

const visible = computed(() => documentVisible.value && hostVisible.value);

export function usePageVisible(): Readonly<Ref<boolean>> {
    if (!listening && typeof document !== 'undefined') {
        listening = true;
        // module-wide, for the page's lifetime: a single listener whatever the number of users
        document.addEventListener('visibilitychange', () => {
            documentVisible.value = document.visibilityState === 'visible';
        });
        documentVisible.value = document.visibilityState === 'visible';
    }
    return visible;
}
