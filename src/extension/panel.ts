// Revspan panel: the Vue page in a webview; its API calls and actions go through messages.
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

    /** Shows a page route (a single panel, reused). */
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

    /** Panel reopened by VS Code ("Reload Window"): same construction as show(), on the saved route. */
    restore(panel: vscode.WebviewPanel, route: string): void {
        if (this.panel) {
            // A single panel: already reopened by a command, the duplicate is closed.
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

    /** Page, title, icon and listeners of the panel. */
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
        // Listeners specific to this panel, released when it closes (not kept until the extension stops).
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
                    // Title updated as soon as requested: the following reads follow the navigation order in the page.
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
