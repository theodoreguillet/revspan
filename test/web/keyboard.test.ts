import { describe, expect, it } from 'vitest';
import { isShortcutEvent, isTyping, trappedFocus } from '../../src/web/lib/keyboard.ts';

/** Key pressed on `target` (document by default), with the given modifiers. */
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document): KeyboardEvent {
    let seen: KeyboardEvent | null = null;
    const listener = (event: Event): void => {
        seen = event as KeyboardEvent;
    };
    target.addEventListener('keydown', listener);
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    target.removeEventListener('keydown', listener);
    if (!seen) {
        throw new Error('event not received');
    }
    return seen;
}

function input(type: string): HTMLInputElement {
    const el = document.createElement('input');
    el.type = type;
    document.body.append(el);
    return el;
}

describe('keyboard shortcuts: modifiers', () => {
    it('key alone or with Shift: shortcut', () => {
        expect(isShortcutEvent(press('j'))).toBe(true);
        expect(isShortcutEvent(press('?', { shiftKey: true }))).toBe(true);
    });

    it('Cmd (meta) or Ctrl alone: never (browser and VS Code shortcuts)', () => {
        expect(isShortcutEvent(press('[', { metaKey: true }))).toBe(false);
        expect(isShortcutEvent(press(']', { ctrlKey: true }))).toBe(false);
        expect(isShortcutEvent(press('j', { ctrlKey: true }))).toBe(false);
    });

    it('AZERTY: [ and ] with Option (Mac) or AltGr (Ctrl + Alt on Windows) stay shortcuts', () => {
        expect(isShortcutEvent(press('[', { altKey: true }))).toBe(true);
        expect(isShortcutEvent(press(']', { altKey: true, shiftKey: true }))).toBe(true);
        expect(isShortcutEvent(press('[', { ctrlKey: true, altKey: true }))).toBe(true);
        expect(isShortcutEvent(press(']', { ctrlKey: true, altKey: true }))).toBe(true);
    });

    it('Alt + letter or digit: ignored (system Alt+letter shortcuts)', () => {
        expect(isShortcutEvent(press('j', { altKey: true }))).toBe(false);
        expect(isShortcutEvent(press('é', { altKey: true }))).toBe(false);
        expect(isShortcutEvent(press('5', { ctrlKey: true, altKey: true }))).toBe(false);
    });

    it('event already handled: ignored', () => {
        const event = new KeyboardEvent('keydown', { key: 'j', cancelable: true });
        event.preventDefault();
        expect(isShortcutEvent(event)).toBe(false);
    });
});

describe('keyboard shortcuts: text input', () => {
    it('text field, text area, list: input (shortcuts ignored)', () => {
        for (const type of ['text', 'search', 'email', 'password']) {
            const el = input(type);
            expect(isTyping(el)).toBe(true);
            expect(isShortcutEvent(press('j', {}, el))).toBe(false);
        }
        expect(isTyping(document.createElement('textarea'))).toBe(true);
        expect(isTyping(document.createElement('select'))).toBe(true);
    });

    it('checkbox, button: no input (shortcuts active after ticking "Hide...")', () => {
        for (const type of ['checkbox', 'radio', 'button']) {
            const el = input(type);
            expect(isTyping(el)).toBe(false);
            expect(isShortcutEvent(press('j', {}, el))).toBe(true);
        }
        expect(isTyping(document.createElement('button'))).toBe(false);
        expect(isTyping(null)).toBe(false);
    });

    it('editable element (contentEditable): input', () => {
        const div = document.createElement('div');
        div.contentEditable = 'true';
        document.body.append(div);
        expect(isTyping(div)).toBe(true);
        expect(isShortcutEvent(press('j', {}, div))).toBe(false);
    });
});

describe('modal box: Tab does not leave the box', () => {
    function dialog(html: string): HTMLElement {
        const root = document.createElement('div');
        root.tabIndex = -1;
        root.innerHTML = html;
        document.body.append(root);
        return root;
    }

    it('Tab on the last element: back to the first; Shift+Tab on the first: the last; otherwise the browser moves on', () => {
        const root = dialog('<a href="#a">a</a><p>texte</p><button disabled>x</button><button>Fermer</button>');
        const [link, , close] = [...root.querySelectorAll<HTMLElement>('a, button')];
        expect(trappedFocus(root, close ?? null, false)).toBe(link);
        expect(trappedFocus(root, link ?? null, true)).toBe(close);
        expect(trappedFocus(root, link ?? null, false)).toBeNull();
        expect(trappedFocus(root, close ?? null, true)).toBeNull();
    });

    it('a single element: focus stays there', () => {
        const root = dialog('<button>Fermer</button>');
        const close = root.querySelector('button');
        expect(trappedFocus(root, close, false)).toBe(close);
        expect(trappedFocus(root, close, true)).toBe(close);
    });

    it('focus outside the box or on the box itself: brought back inside', () => {
        const root = dialog('<button>Un</button><button>Deux</button>');
        const [one, two] = [...root.querySelectorAll('button')];
        expect(trappedFocus(root, document.body, false)).toBe(one);
        expect(trappedFocus(root, document.body, true)).toBe(two);
        expect(trappedFocus(root, root, true)).toBe(two);
        expect(trappedFocus(root, null, false)).toBe(one);
    });
});
