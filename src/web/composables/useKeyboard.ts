// Keyboard shortcuts: listens on document during the component's life, ignoring text input.
import { onBeforeUnmount, onMounted } from 'vue';
import { isShortcutEvent } from '../lib/keyboard.ts';
import { shortcutsOpen } from './useShortcuts.ts';

/**
 * handler(key, event) returns true if it handled the key (the event is then cancelled).
 * Ignored: Cmd, Ctrl alone, Alt + letter or digit (see isShortcutEvent), text input and the open help overlay.
 */
export function useKeyboard(handler: (key: string, event: KeyboardEvent) => boolean): void {
    const onKey = (event: KeyboardEvent): void => {
        if (!isShortcutEvent(event) || shortcutsOpen.value) {
            return;
        }
        if (handler(event.key, event)) {
            event.preventDefault();
        }
    };
    onMounted(() => document.addEventListener('keydown', onKey));
    onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
}
