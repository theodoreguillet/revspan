// VS Code's localization for the pure code of lib/: vscode.l10n.t and the display language.
import * as vscode from 'vscode';
import { createL10n, pageLocale, type L10n, type PageLocale } from './lib/l10n.ts';

export function hostL10n(): L10n {
    return createL10n((message, args) => vscode.l10n.t(message, args ?? {}), vscode.env.language);
}

/** Language of the webview page: VS Code's display language (French for fr*, English otherwise). */
export const hostPageLocale = (): PageLocale => pageLocale(vscode.env.language);
