// Keyboard shortcut help (global overlay).
import { ref } from 'vue';
import type { MessageKey } from '../i18n/index.ts';
import { altLeftGoesBack, isWindowsPlatform } from '../lib/keyboard.ts';
import { isVsCode } from '../services/host.ts';

export const shortcutsOpen = ref(false);

/** Alt+← goes back from a definition (not in the VS Code webview on Windows: VS Code's Go Back; the chip remains). */
export const ALT_LEFT_BACK = altLeftGoesBack(isVsCode, typeof navigator !== 'undefined' && isWindowsPlatform(navigator.platform, navigator.userAgent));

/** Keys (alternatives separated by " / ") and description of each shortcut. */
export const SHORTCUTS = [
    { keys: 'shortcuts.keysFile', label: 'shortcuts.file' },
    { keys: 'shortcuts.keysThread', label: 'shortcuts.thread' },
    { keys: 'shortcuts.keysViewed', label: 'shortcuts.viewed' },
    { keys: 'shortcuts.keysAllViewed', label: 'shortcuts.allViewed' },
    { keys: 'shortcuts.keysSearch', label: 'shortcuts.search' },
    { keys: 'shortcuts.keysGoto', label: 'shortcuts.goto' },
    ALT_LEFT_BACK ? { keys: 'shortcuts.keysBack', label: 'shortcuts.back' } : { keys: 'shortcuts.keysBackChip', label: 'shortcuts.backChip' },
    { keys: 'shortcuts.keysVersion', label: 'shortcuts.version' },
    { keys: 'shortcuts.keysClick', label: 'shortcuts.click' },
    { keys: 'shortcuts.keysExtend', label: 'shortcuts.extend' },
    { keys: 'shortcuts.keysSend', label: 'shortcuts.send' },
    { keys: 'shortcuts.keysRange', label: 'shortcuts.range' },
    { keys: 'shortcuts.keysRangeDrag', label: 'shortcuts.rangeDrag' },
    { keys: 'shortcuts.keysEscape', label: 'shortcuts.escape' },
    { keys: 'shortcuts.keysHomeSearch', label: 'shortcuts.homeSearch' },
    { keys: 'shortcuts.keysHelp', label: 'shortcuts.help' },
] as const satisfies readonly { keys: MessageKey; label: MessageKey }[];

export function openShortcuts(): void {
    shortcutsOpen.value = true;
}

export function closeShortcuts(): void {
    shortcutsOpen.value = false;
}
