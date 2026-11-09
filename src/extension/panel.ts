// Panneau Revspan : la page Vue dans un webview ; ses appels d'API et ses actions passent par messages.
import fs from 'node:fs';
import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/webview-protocol.ts';
import { errorPayload } from '../server/errors.ts';
import type { ExtensionApp } from './app-context.ts';
import type { DiffDocuments } from './diff-documents.ts';
import { hostL10n, hostPageLocale } from './host-l10n.ts';
import { callApi, isSuccessfulWrite } from './lib/bridge.ts';
import { errorText } from './lib/error-text.ts';
import { PANEL_VIEW_TYPE, panelTitle, routeOfApiRead } from './lib/panel-route.ts';
import { buildWebviewHtml } from './lib/webview-html.ts';
import { parseWebviewMessage } from './lib/webview-messages.ts';
import { openLocalFile } from './local-files.ts';

/** Tab title of a page route, in VS Code's display language. */
const titleOf = (route: string): string => panelTitle(hostL10n().t, route);

export class RevspanPanel {
    private readonly context: vscode.ExtensionContext;
    private readonly app: ExtensionApp;
    private readonly diffs: DiffDocuments;
    private readonly onWrite: () => void;
    private panel: vscode.WebviewPanel | null = null;

    constructor({ context, app, diffs, onWrite }: { context: vscode.ExtensionContext; app: ExtensionApp; diffs: DiffDocuments; onWrite: () => void }) {
        this.context = context;
        this.app = app;
        this.diffs = diffs;
        this.onWrite = onWrite;
    }

    /** Affiche une route de la page (un seul panneau, réutilisé). */
    show(route: string): void {
        if (this.panel) {
            this.panel.title = titleOf(route);
            this.panel.reveal();
            void this.post({ type: 'navigate', route });
            return;
        }
        const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, titleOf(route), vscode.ViewColumn.Active, {
            ...this.webviewOptions(),
            retainContextWhenHidden: true,
        });
        this.attach(panel, route);
    }

    /** Panneau rouvert par VS Code (« Recharger la fenêtre ») : même construction que show(), sur la route enregistrée. */
    restore(panel: vscode.WebviewPanel, route: string): void {
        if (this.panel) {
            // Un seul panneau : déjà rouvert par une commande, le doublon est fermé.
            panel.dispose();
            return;
        }
        panel.webview.options = this.webviewOptions();
        this.attach(panel, route);
    }

    private get webDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'web');
    }

    private webviewOptions(): vscode.WebviewOptions {
        return { enableScripts: true, localResourceRoots: [this.webDir] };
    }

    /** Page, titre, icône et écouteurs du panneau. */
    private attach(panel: vscode.WebviewPanel, route: string): void {
        panel.title = titleOf(route);
        panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
        const indexHtml = fs.readFileSync(vscode.Uri.joinPath(this.webDir, 'index.html').fsPath, 'utf8');
        panel.webview.html = buildWebviewHtml(indexHtml, {
            assetsBaseUri: panel.webview.asWebviewUri(this.webDir).toString(),
            cspSource: panel.webview.cspSource,
            initialRoute: route,
            locale: hostPageLocale(),
        });
        // Écouteurs propres à ce panneau, libérés à sa fermeture (et non gardés jusqu'à l'arrêt de l'extension).
        const listeners: vscode.Disposable[] = [];
        panel.webview.onDidReceiveMessage((data: unknown) => {
            const message = parseWebviewMessage(data);
            if (message) {
                void this.handle(message);
            }
        }, undefined, listeners);
        panel.onDidDispose(() => {
            if (this.panel === panel) {
                this.panel = null;
            }
            listeners.forEach((listener) => listener.dispose());
        }, undefined, listeners);
        this.panel = panel;
    }

    private post(message: HostToWebview): Thenable<boolean> {
        return this.panel?.webview.postMessage(message) ?? Promise.resolve(false);
    }

    private async handle(message: WebviewToHost): Promise<void> {
        try {
            switch (message.type) {
                case 'request': {
                    // Titre mis à jour dès la demande : les lectures suivent l'ordre de navigation dans la page.
                    const route = routeOfApiRead(message.method, message.path);
                    if (this.panel && route) {
                        this.panel.title = titleOf(route);
                    }
                    const result = await callApi(this.app.http, message);
                    await this.post({ type: 'response', id: message.id, ...result });
                    if (isSuccessfulWrite(message, result)) {
                        this.onWrite();
                    }
                    return;
                }
                case 'openFile':
                    return await openLocalFile(this.app.services.prs, message.ref, message.path, message.line);
                case 'openDiff':
                    return await this.diffs.open(message.ref, message.from, message.to, message.path, message.oldPath);
            }
        } catch (error) {
            if (message.type === 'request') {
                await this.post({ type: 'response', id: message.id, status: 500, body: { error: errorPayload(error) } });
            } else {
                void vscode.window.showErrorMessage(vscode.l10n.t('Revspan: {message}', { message: errorText(hostL10n().t, errorPayload(error)) }));
            }
        }
    }
}
