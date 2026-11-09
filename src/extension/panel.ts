// Panneau Revspan : la page Vue dans un webview ; ses appels d'API et ses actions passent par messages.
import fs from 'node:fs';
import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/webview-protocol.ts';
import type { ExtensionApp } from './app-context.ts';
import type { DiffDocuments } from './diff-documents.ts';
import { callApi, isSuccessfulWrite } from './lib/bridge.ts';
import { buildWebviewHtml } from './lib/webview-html.ts';
import { parseWebviewMessage } from './lib/webview-messages.ts';
import { openLocalFile } from './local-files.ts';

const PR_ROUTE = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)/;

function titleFor(route: string): string {
    const match = PR_ROUTE.exec(route);
    return match ? `PR #${match[3]} · ${match[2]}` : route.startsWith('/settings') ? 'Revspan · Réglages' : 'Revspan';
}

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
            this.panel.title = titleFor(route);
            this.panel.reveal();
            void this.post({ type: 'navigate', route });
            return;
        }
        const webDir = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'web');
        const panel = vscode.window.createWebviewPanel('revspan', titleFor(route), vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [webDir],
        });
        panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
        const indexHtml = fs.readFileSync(vscode.Uri.joinPath(webDir, 'index.html').fsPath, 'utf8');
        panel.webview.html = buildWebviewHtml(indexHtml, {
            assetsBaseUri: panel.webview.asWebviewUri(webDir).toString(),
            cspSource: panel.webview.cspSource,
            initialRoute: route,
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
                    const result = await callApi(this.app.http, message);
                    await this.post({ type: 'response', id: message.id, ...result });
                    if (isSuccessfulWrite(message, result)) {
                        this.onWrite();
                    }
                    const route = PR_ROUTE.exec(message.path.replace(/^\/api/, ''));
                    if (this.panel && route && message.method === 'GET') {
                        this.panel.title = titleFor(route[0]);
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
                await this.post({ type: 'response', id: message.id, status: 500, body: { error: { code: 'INTERNAL', message: (error as Error).message } } });
            } else {
                void vscode.window.showErrorMessage(`Revspan : ${(error as Error).message}`);
            }
        }
    }
}
