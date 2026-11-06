// Point d'entrée de l'extension VS Code Strata.
import * as vscode from 'vscode';
import type { PrRef } from '../shared/api.ts';
import { parsePrUrl } from '../shared/pr-url.ts';
import { createExtensionApp } from './app-context.ts';
import { DiffDocuments } from './diff-documents.ts';
import { HomeTreeProvider } from './home-tree-provider.ts';
import { DIFF_SCHEME } from './lib/diff-uri.ts';
import { StrataPanel } from './panel.ts';

const prRoute = (ref: PrRef): string => `/pr/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.repo)}/${ref.id}`;

async function askPrRef(): Promise<PrRef | null> {
    const url = await vscode.window.showInputBox({
        title: 'Ouvrir une PR Bitbucket',
        prompt: 'URL de la PR',
        placeHolder: 'https://bitbucket.org/<workspace>/<dépôt>/pull-requests/<numéro>',
        validateInput: (value) => (parsePrUrl(value) ? null : 'URL de PR Bitbucket attendue'),
    });
    return url ? parsePrUrl(url) : null;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const app = await createExtensionApp(context);
    const tree = new HomeTreeProvider(app.services.home);
    const diffs = new DiffDocuments(app.services.prs);
    const panel = new StrataPanel({ context, app, diffs, onWrite: () => tree.refresh() });

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('strata.home', tree),
        vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
        vscode.commands.registerCommand('strata.openHome', () => panel.show('/')),
        vscode.commands.registerCommand('strata.openSettings', () => panel.show('/settings')),
        vscode.commands.registerCommand('strata.refresh', () => tree.refresh({ fresh: true })),
        vscode.commands.registerCommand('strata.openPr', async (ref?: PrRef) => {
            const target = ref ?? await askPrRef();
            if (target) {
                panel.show(prRoute(target));
            }
        }),
    );
}

export function deactivate(): void {
    // Rien à libérer : tout est enregistré dans context.subscriptions.
}
