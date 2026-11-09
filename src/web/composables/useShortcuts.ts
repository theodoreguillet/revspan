// Keyboard shortcut help (global overlay).
import { ref } from 'vue';
import type { MessageKey } from '../i18n/index.ts';

export const shortcutsOpen = ref(false);

/** Keys (alternatives separated by " / ") and description of each shortcut. */
export const SHORTCUTS = [
    { keys: 'shortcuts.keysFile', label: 'shortcuts.file' },
    { keys: 'shortcuts.keysThread', label: 'shortcuts.thread' },
    { keys: 'shortcuts.keysViewed', label: 'shortcuts.viewed' },
    { keys: 'shortcuts.keysVersion', label: 'shortcuts.version' },
    { keys: 'shortcuts.keysExtend', label: 'shortcuts.extend' },
    { keys: 'shortcuts.keysSend', label: 'shortcuts.send' },
    { keys: 'shortcuts.keysEscape', label: 'shortcuts.escape' },
    { keys: 'shortcuts.keysHelp', label: 'shortcuts.help' },
] as const satisfies readonly { keys: MessageKey; label: MessageKey }[];

export function openShortcuts(): void {
    shortcutsOpen.value = true;
}

export function closeShortcuts(): void {
    shortcutsOpen.value = false;
}
