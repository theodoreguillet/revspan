// Raccourcis clavier : quels événements sont des raccourcis (modificateurs, saisie de texte en cours).

// Champs qui ne consomment pas les lettres : les raccourcis restent actifs (ex. après avoir coché « Masquer… »).
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);

/** Vrai si l'utilisateur est en train de saisir du texte. */
export function isTyping(target: EventTarget | null): boolean {
    if (target instanceof HTMLInputElement) {
        return !NON_TEXT_INPUTS.has(target.type);
    }
    return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented' | 'target'>;

const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

/**
 * Les modificateurs laissent-ils passer un raccourci ? ⌘ : jamais ; Ctrl seul : jamais (raccourcis du navigateur et de
 * VS Code). Alt : sur AZERTY, [ et ] se tapent avec Option (Mac) ou AltGr (Ctrl + Alt sous Windows) ; seuls Alt + lettre
 * ou chiffre sont ignorés.
 */
function modifiersAllowShortcut({ key, metaKey, ctrlKey, altKey }: KeyEventLike): boolean {
    if (metaKey || (ctrlKey && !altKey)) {
        return false;
    }
    return !altKey || !LETTER_OR_DIGIT.test(key);
}

/** Vrai si l'événement peut déclencher un raccourci de la page (pas déjà traité, pas pendant une saisie de texte). */
export function isShortcutEvent(event: KeyEventLike): boolean {
    return !event.defaultPrevented && modifiersAllowShortcut(event) && !isTyping(event.target);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Tab (back : Maj+Tab) dans une boîte modale : élément où mettre le focus pour qu'il reste dans `root` (du dernier au
 * premier élément et inversement, ou dedans s'il était dehors), ou null si le navigateur peut avancer normalement.
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
