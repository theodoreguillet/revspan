import { describe, expect, it } from 'vitest';
import { altLeftGoesBack, isGotoClick, isMacPlatform, isShortcutEvent, isTyping, isWindowsPlatform, trappedFocus } from '../../src/web/lib/keyboard.ts';

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

describe('go to definition: the modifier of the click', () => {
    const click = (init: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> & { button?: number } = {}) =>
        ({ button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });

    it('macOS: ⌘+click (Ctrl+click is a right click there)', () => {
        expect(isMacPlatform('MacIntel')).toBe(true);
        expect(isMacPlatform('iPad')).toBe(true);
        expect(isGotoClick(click({ metaKey: true }), true)).toBe(true);
        expect(isGotoClick(click({ ctrlKey: true }), true)).toBe(false);
    });

    it('elsewhere: Ctrl+click', () => {
        expect(isMacPlatform('Win32')).toBe(false);
        expect(isMacPlatform('Linux x86_64')).toBe(false);
        expect(isGotoClick(click({ ctrlKey: true }), false)).toBe(true);
        expect(isGotoClick(click({ metaKey: true }), false)).toBe(false);
    });

    it('a plain click, another button or another modifier with it: not a go to definition', () => {
        expect(isGotoClick(click(), false)).toBe(false);
        expect(isGotoClick(click(), true)).toBe(false);
        expect(isGotoClick(click({ ctrlKey: true, button: 1 }), false)).toBe(false);
        expect(isGotoClick(click({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
        expect(isGotoClick(click({ metaKey: true, altKey: true }), true)).toBe(false);
        expect(isGotoClick(click({ metaKey: true, ctrlKey: true }), true)).toBe(false);
    });
});

describe('go to definition: Alt+← for back', () => {
    const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.95.0 Chrome/128.0 Electron/32.2.1 Safari/537.36';
    const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

    it('Windows from the platform or, when it is empty, the user agent', () => {
        expect(isWindowsPlatform('Win32', '')).toBe(true);
        expect(isWindowsPlatform('', WIN_UA)).toBe(true);
        expect(isWindowsPlatform('MacIntel', MAC_UA)).toBe(false);
        expect(isWindowsPlatform('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
    });

    it('in the VS Code webview on Windows, Alt+← stays VS Code\'s Go Back; everywhere else it is the page\'s', () => {
        expect(altLeftGoesBack(true, true)).toBe(false);
        expect(altLeftGoesBack(true, false)).toBe(true);
        expect(altLeftGoesBack(false, true)).toBe(true);
        expect(altLeftGoesBack(false, false)).toBe(true);
    });
});
