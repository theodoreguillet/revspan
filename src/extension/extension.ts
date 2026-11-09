// Point d'entrée de l'extension VS Code Revspan.
import * as vscode from 'vscode';
import type { PrRef } from '../shared/api.ts';
import { parsePrUrl } from '../shared/pr-url.ts';
import { createExtensionApp, REPOS_SETTING } from './app-context.ts';
import { DiffDocuments } from './diff-documents.ts';
import { HomeTreeProvider } from './home-tree-provider.ts';
import { DIFF_SCHEME } from './lib/diff-uri.ts';
import { PANEL_VIEW_TYPE, restoredRoute } from './lib/panel-route.ts';
import { RevspanPanel } from './panel.ts';

const prRoute = (ref: PrRef): string => `/pr/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.repo)}/${ref.id}`;

async function askPrRef(): Promise<PrRef | null> {
    const url = await vscode.window.showInputBox({
        title: vscode.l10n.t('Open a Bitbucket PR'),
        prompt: vscode.l10n.t('PR URL'),
        placeHolder: vscode.l10n.t('https://bitbucket.org/<workspace>/<repository>/pull-requests/<number>'),
        validateInput: (value) => (parsePrUrl(value) ? null : vscode.l10n.t('Bitbucket PR URL expected')),
    });
    return url ? parsePrUrl(url) : null;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const app = await createExtensionApp(context);
    const tree = new HomeTreeProvider(app.services.home);
    const diffs = new DiffDocuments(app.services.prs);
    const panel = new RevspanPanel({ context, app, diffs, onWrite: () => tree.refresh() });

    context.subscriptions.push(
        tree,
        vscode.window.registerTreeDataProvider('revspan.home', tree),
        vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
        // Après « Recharger la fenêtre », VS Code rouvre le panneau avec l'état enregistré par la page (sa route).
        vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
            deserializeWebviewPanel: async (webviewPanel, state: unknown) => panel.restore(webviewPanel, restoredRoute(state)),
        }),
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
