// Raccourcis clavier : écoute document pendant la vie du composant, en ignorant la saisie de texte.
import { onBeforeUnmount, onMounted } from 'vue';
import { shortcutsOpen } from './useShortcuts.ts';

// Champs qui ne consomment pas les lettres : les raccourcis restent actifs (ex. après avoir coché « Masquer… »).
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);

/** Vrai si l'utilisateur est en train de saisir du texte. */
export function isTyping(target: EventTarget | null): boolean {
    if (target instanceof HTMLInputElement) {
        return !NON_TEXT_INPUTS.has(target.type);
    }
    return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

/**
 * handler(key, event) renvoie true s'il a traité la touche (l'événement est alors annulé).
 * Les touches avec ⌘/Ctrl/Alt, la saisie de texte et l'overlay d'aide ouvert sont ignorés.
 */
export function useKeyboard(handler: (key: string, event: KeyboardEvent) => boolean): void {
    const onKey = (event: KeyboardEvent): void => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || shortcutsOpen.value) {
            return;
        }
        if (handler(event.key, event)) {
            event.preventDefault();
        }
    };
    onMounted(() => document.addEventListener('keydown', onKey));
    onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
}
