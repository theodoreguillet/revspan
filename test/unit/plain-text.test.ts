import { describe, expect, it } from 'vitest';
import { plainMessageText } from '../../src/extension/lib/plain-text.ts';
import { notificationMessage } from '../../src/extension/lib/notification-text.ts';

// VS Code 1.147 `parseLinkedText`: what the notification renderer turns into a clickable link.
const VSCODE_LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi;
const links = (text: string): RegExpMatchArray[] => [...text.matchAll(VSCODE_LINK)];

const ATTACKS = [
    'Fix [details](command:workbench.action.terminal.sendSequence?%7B%7D "Open")',
    'See [file](file:///etc/passwd)',
    'See [site](https://evil.example/login)',
];

// A translator like `vscode.l10n.t`: substitutes `{name}` placeholders.
const translate = (message: string, args: Record<string, string>): string =>
    message.replace(/\{(\w+)\}/g, (_, name: string) => args[name] ?? '');

describe('plainMessageText', () => {
    it('leaves no link VS Code would parse', () => {
        for (const attack of ATTACKS) {
            expect(links(attack)).toHaveLength(1);
            expect(links(plainMessageText(attack))).toHaveLength(0);
        }
    });

    it('puts a zero-width space (U+200B) between "]" and "(", and nothing else', () => {
        expect(plainMessageText('[a](b) and [c](d)')).toBe('[a]\u200B(b) and [c]\u200B(d)');
    });

    it('keeps ordinary text unchanged', () => {
        expect(plainMessageText('feat(records): archive [WIP]')).toBe('feat(records): archive [WIP]');
    });
});

describe('notificationMessage', () => {
    it('builds notification messages without links', () => {
        for (const attack of ATTACKS) {
            for (const kind of ['newPullRequest', 'newVersion', 'buildFailed'] as const) {
                const message = notificationMessage(translate, { kind, title: attack, author: attack });
                expect(links(message)).toHaveLength(0);
                expect(message).toContain(attack.slice(0, 8));
            }
        }
        expect(links(notificationMessage(translate, { kind: 'newPullRequest', title: ATTACKS[1]!, author: null }))).toHaveLength(0);
    });
});
