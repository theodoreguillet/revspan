// Raccourcis clavier : écoute document pendant la vie du composant, en ignorant la saisie de texte.
import { onBeforeUnmount, onMounted } from 'vue';
import { isShortcutEvent } from '../lib/keyboard.ts';
import { shortcutsOpen } from './useShortcuts.ts';

/**
 * handler(key, event) renvoie true s'il a traité la touche (l'événement est alors annulé).
 * Ignorés : ⌘, Ctrl seul, Alt + lettre ou chiffre (voir isShortcutEvent), la saisie de texte et l'overlay d'aide ouvert.
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
