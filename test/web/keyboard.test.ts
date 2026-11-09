import { describe, expect, it } from 'vitest';
import { isShortcutEvent, isTyping, trappedFocus } from '../../src/web/lib/keyboard.ts';

/** Touche pressée sur `target` (document par défaut), avec les modificateurs donnés. */
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document): KeyboardEvent {
    let seen: KeyboardEvent | null = null;
    const listener = (event: Event): void => {
        seen = event as KeyboardEvent;
    };
    target.addEventListener('keydown', listener);
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    target.removeEventListener('keydown', listener);
    if (!seen) {
        throw new Error('événement non reçu');
    }
    return seen;
}

function input(type: string): HTMLInputElement {
    const el = document.createElement('input');
    el.type = type;
    document.body.append(el);
    return el;
}

describe('raccourcis clavier : modificateurs', () => {
    it('touche seule ou avec Maj : raccourci', () => {
        expect(isShortcutEvent(press('j'))).toBe(true);
        expect(isShortcutEvent(press('?', { shiftKey: true }))).toBe(true);
    });

    it('⌘ (meta) ou Ctrl seul : jamais (raccourcis du navigateur et de VS Code)', () => {
        expect(isShortcutEvent(press('[', { metaKey: true }))).toBe(false);
        expect(isShortcutEvent(press(']', { ctrlKey: true }))).toBe(false);
        expect(isShortcutEvent(press('j', { ctrlKey: true }))).toBe(false);
    });

    it('AZERTY : [ et ] avec Option (Mac) ou AltGr (Ctrl + Alt sous Windows) restent des raccourcis', () => {
        expect(isShortcutEvent(press('[', { altKey: true }))).toBe(true);
        expect(isShortcutEvent(press(']', { altKey: true, shiftKey: true }))).toBe(true);
        expect(isShortcutEvent(press('[', { ctrlKey: true, altKey: true }))).toBe(true);
        expect(isShortcutEvent(press(']', { ctrlKey: true, altKey: true }))).toBe(true);
    });

    it('Alt + lettre ou chiffre : ignoré (raccourcis Alt+lettre du système)', () => {
        expect(isShortcutEvent(press('j', { altKey: true }))).toBe(false);
        expect(isShortcutEvent(press('é', { altKey: true }))).toBe(false);
        expect(isShortcutEvent(press('5', { ctrlKey: true, altKey: true }))).toBe(false);
    });

    it('événement déjà traité : ignoré', () => {
        const event = new KeyboardEvent('keydown', { key: 'j', cancelable: true });
        event.preventDefault();
        expect(isShortcutEvent(event)).toBe(false);
    });
});

describe('raccourcis clavier : saisie de texte', () => {
    it('champ texte, zone de texte, liste : saisie (raccourcis ignorés)', () => {
        for (const type of ['text', 'search', 'email', 'password']) {
            const el = input(type);
            expect(isTyping(el)).toBe(true);
            expect(isShortcutEvent(press('j', {}, el))).toBe(false);
        }
        expect(isTyping(document.createElement('textarea'))).toBe(true);
        expect(isTyping(document.createElement('select'))).toBe(true);
    });

    it('case à cocher, bouton : pas de saisie (raccourcis actifs après avoir coché « Masquer… »)', () => {
        for (const type of ['checkbox', 'radio', 'button']) {
            const el = input(type);
            expect(isTyping(el)).toBe(false);
            expect(isShortcutEvent(press('j', {}, el))).toBe(true);
        }
        expect(isTyping(document.createElement('button'))).toBe(false);
        expect(isTyping(null)).toBe(false);
    });

    it('élément éditable (contentEditable) : saisie', () => {
        const div = document.createElement('div');
        div.contentEditable = 'true';
        document.body.append(div);
        expect(isTyping(div)).toBe(true);
        expect(isShortcutEvent(press('j', {}, div))).toBe(false);
    });
});

describe('boîte modale : Tab ne sort pas de la boîte', () => {
    function dialog(html: string): HTMLElement {
        const root = document.createElement('div');
        root.tabIndex = -1;
        root.innerHTML = html;
        document.body.append(root);
        return root;
    }

    it('Tab sur le dernier élément : retour au premier ; Maj+Tab sur le premier : le dernier ; sinon le navigateur avance', () => {
        const root = dialog('<a href="#a">a</a><p>texte</p><button disabled>x</button><button>Fermer</button>');
        const [link, , close] = [...root.querySelectorAll<HTMLElement>('a, button')];
        expect(trappedFocus(root, close ?? null, false)).toBe(link);
        expect(trappedFocus(root, link ?? null, true)).toBe(close);
        expect(trappedFocus(root, link ?? null, false)).toBeNull();
        expect(trappedFocus(root, close ?? null, true)).toBeNull();
    });

    it('un seul élément : le focus y reste', () => {
        const root = dialog('<button>Fermer</button>');
        const close = root.querySelector('button');
        expect(trappedFocus(root, close, false)).toBe(close);
        expect(trappedFocus(root, close, true)).toBe(close);
    });

    it('focus hors de la boîte ou sur la boîte elle-même : ramené dedans', () => {
        const root = dialog('<button>Un</button><button>Deux</button>');
        const [one, two] = [...root.querySelectorAll('button')];
        expect(trappedFocus(root, document.body, false)).toBe(one);
        expect(trappedFocus(root, document.body, true)).toBe(two);
        expect(trappedFocus(root, root, true)).toBe(two);
        expect(trappedFocus(root, null, false)).toBe(one);
    });
});
