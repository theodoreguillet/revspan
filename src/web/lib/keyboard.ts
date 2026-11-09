// Keyboard shortcuts: which events are shortcuts (modifiers, text input in progress).

// Fields that do not consume letters: shortcuts stay active (e.g. after ticking "Hide...").
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);

/** True if the user is typing text. */
export function isTyping(target: EventTarget | null): boolean {
    if (target instanceof HTMLInputElement) {
        return !NON_TEXT_INPUTS.has(target.type);
    }
    return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented' | 'target'>;

const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

/**
 * Do the modifiers let a shortcut through? Cmd: never; Ctrl alone: never (browser and VS Code shortcuts).
 * Alt: on AZERTY, [ and ] are typed with Option (Mac) or AltGr (Ctrl + Alt on Windows); only Alt + letter
 * or digit are ignored.
 */
function modifiersAllowShortcut({ key, metaKey, ctrlKey, altKey }: KeyEventLike): boolean {
    if (metaKey || (ctrlKey && !altKey)) {
        return false;
    }
    return !altKey || !LETTER_OR_DIGIT.test(key);
}

/** True if the event can trigger a page shortcut (not already handled, not during text input). */
export function isShortcutEvent(event: KeyEventLike): boolean {
    return !event.defaultPrevented && modifiersAllowShortcut(event) && !isTyping(event.target);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Tab (back: Shift+Tab) in a modal box: element to focus so that focus stays inside `root` (from the last to the
 * first element and vice versa, or inside if it was outside), or null if the browser can move on normally.
 */
export function trappedFocus(root: HTMLElement, active: Element | null, back: boolean): HTMLElement | null {
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0] ?? root;
    const last = items[items.length - 1] ?? root;
    const [edge, wrapTo] = back ? [first, last] : [last, first];
    if (!active || active === root || active === edge || !root.contains(active)) {
        return wrapTo;
    }
    return null;
}
