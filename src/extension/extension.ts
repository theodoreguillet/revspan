// Point d'entrée de l'extension VS Code Revspan.
import * as vscode from 'vscode';
import type { PrRef } from '../shared/api.ts';
import { parsePrUrl } from '../shared/pr-url.ts';
import { createExtensionApp, REPOS_SETTING } from './app-context.ts';
import { DiffDocuments } from './diff-documents.ts';
import { HomeTreeProvider } from './home-tree-provider.ts';
import { DIFF_SCHEME } from './lib/diff-uri.ts';
import { RevspanPanel } from './panel.ts';

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
    const panel = new RevspanPanel({ context, app, diffs, onWrite: () => tree.refresh() });

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('revspan.home', tree),
        vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
        vscode.commands.registerCommand('revspan.openHome', () => panel.show('/')),
        vscode.commands.registerCommand('revspan.openSettings', () => panel.show('/settings')),
        vscode.commands.registerCommand('revspan.refresh', () => tree.refresh({ fresh: true })),
        vscode.commands.registerCommand('revspan.openPr', async (ref?: PrRef) => {
            const target = ref ?? await askPrRef();
            if (target) {
                panel.show(prRoute(target));
            }
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(REPOS_SETTING.id)) {
                tree.refresh();
            }
        }),
    );
}

export function deactivate(): void {
    // Rien à libérer : tout est enregistré dans context.subscriptions.
}
