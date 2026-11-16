// Revspan tabs: the Vue page in webviews (the "Revspan" tab and one tab per PR); API calls and actions go through messages.
import fs from 'node:fs';
import * as vscode from 'vscode';
import { roleOfRoute, type PanelRole } from '../shared/panel-role.ts';
import type { HostToWebview, WebviewToHost } from '../shared/webview-protocol.ts';
import { errorPayload } from '../server/errors.ts';
import type { ExtensionApp } from './app-context.ts';
import type { DiffDocuments } from './diff-documents.ts';
import { hostL10n, hostPageLocale } from './host-l10n.ts';
import { callApi, isSuccessfulWrite } from './lib/bridge.ts';
import { errorText } from './lib/error-text.ts';
import { PANEL_VIEW_TYPE, panelTitle, routeOfApiRead, screenOfRoute } from './lib/panel-route.ts';
import { buildWebviewHtml } from './lib/webview-html.ts';
import { parseWebviewMessage } from './lib/webview-messages.ts';
import { openLocalFile } from './local-files.ts';

/** Tab title of a page route, in VS Code's display language. */
const titleOf = (route: string): string => panelTitle(hostL10n().t, route);

/** A Revspan tab: its role, fixed when it opens (home page and settings, or one PR), and what it shows. */
interface Tab {
    readonly role: PanelRole;
    readonly panel: vscode.WebviewPanel;
    /** Screen shown as far as the extension knows (screenOfRoute: the PR, not its range). */
    shown: string;
}

/** The Revspan tabs: the "Revspan" tab (home page and settings) and one tab per open PR. */
export class RevspanPanel {
    private readonly context: vscode.ExtensionContext;
    private readonly app: ExtensionApp;
    private readonly diffs: DiffDocuments;
    private readonly onWrite: () => void;
    private readonly tabs = new Map<PanelRole, Tab>();

    constructor({ context, app, diffs, onWrite }: { context: vscode.ExtensionContext; app: ExtensionApp; diffs: DiffDocuments; onWrite: () => void }) {
        this.context = context;
        this.app = app;
        this.diffs = diffs;
        this.onWrite = onWrite;
    }

    /** Whether a Revspan tab is open and on screen. */
    get visible(): boolean {
        return [...this.tabs.values()].some((tab) => tab.panel.visible);
    }

    /** Shows a page route in the tab of its role: brought to the front if open (no duplicate), created otherwise. */
    show(route: string): void {
        const tab = this.tabs.get(roleOfRoute(route));
        if (tab) {
            tab.panel.reveal();
            // An open PR keeps its range unless one is asked; the "Revspan" tab goes to the asked screen.
            if (route !== tab.shown) {
                tab.shown = screenOfRoute(route);
                tab.panel.title = titleOf(route);
                void this.post(tab, { type: 'navigate', route });
            }
            return;
        }
        const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, titleOf(route), vscode.ViewColumn.Active, {
            ...this.webviewOptions(),
            retainContextWhenHidden: true,
        });
        this.attach(panel, route);
    }

    /**
     * Tab reopened by VS Code ("Reload Window"): same construction as show(), on the saved route, in the role of that
     * route (a 3.3 panel left on a PR becomes the tab of that PR). Closed if a tab already holds that role.
     */
    restore(panel: vscode.WebviewPanel, route: string): void {
        if (this.tabs.has(roleOfRoute(route))) {
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

    /** Page, title, icon and listeners of a tab. */
    private attach(panel: vscode.WebviewPanel, route: string): void {
        const tab: Tab = { role: roleOfRoute(route), panel, shown: screenOfRoute(route) };
        panel.title = titleOf(route);
        panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
        const indexHtml = fs.readFileSync(vscode.Uri.joinPath(this.webDir, 'index.html').fsPath, 'utf8');
        panel.webview.html = buildWebviewHtml(indexHtml, {
            assetsBaseUri: panel.webview.asWebviewUri(this.webDir).toString(),
            cspSource: panel.webview.cspSource,
            initialRoute: route,
            locale: hostPageLocale(),
        });
        // Listeners specific to this tab, released when it closes (not kept until the extension stops).
        const listeners: vscode.Disposable[] = [];
        panel.webview.onDidReceiveMessage((data: unknown) => {
            const message = parseWebviewMessage(data);
            if (message) {
                void this.handle(tab, message);
            }
        }, undefined, listeners);
        // A hidden tab stays alive (retainContextWhenHidden): its page pauses its background work.
        panel.onDidChangeViewState(() => {
            void this.post(tab, { type: 'visibility', visible: panel.visible });
        }, undefined, listeners);
        panel.onDidDispose(() => {
            if (this.tabs.get(tab.role) === tab) {
                this.tabs.delete(tab.role);
            }
            listeners.forEach((listener) => listener.dispose());
        }, undefined, listeners);
        this.tabs.set(tab.role, tab);
    }

    private post(tab: Tab, message: HostToWebview): Thenable<boolean> {
        return tab.panel.webview.postMessage(message);
    }

    private async handle(tab: Tab, message: WebviewToHost): Promise<void> {
        try {
            switch (message.type) {
                case 'request': {
                    // Title updated as soon as requested: the following reads follow the navigation order in the page.
                    // Only a screen of the tab's role counts (a PR tab keeps its title whatever it reads).
                    const route = routeOfApiRead(message.method, message.path);
                    if (route && roleOfRoute(route) === tab.role) {
                        tab.shown = route;
                        tab.panel.title = titleOf(route);
                    }
                    const result = await callApi(this.app.http, message);
                    await this.post(tab, { type: 'response', id: message.id, ...result });
                    if (isSuccessfulWrite(message, result)) {
                        this.onWrite();
                    }
                    return;
                }
                case 'openRoute':
                    this.show(message.route);
                    return;
                case 'openFile':
                    return await openLocalFile(this.app.services.prs, message.ref, message.path, message.line);
                case 'openDiff':
                    return await this.diffs.open(message.ref, message.from, message.to, message.path, message.oldPath);
            }
        } catch (error) {
            if (message.type === 'request') {
                await this.post(tab, { type: 'response', id: message.id, status: 500, body: { error: errorPayload(error) } });
            } else {
                void vscode.window.showErrorMessage(vscode.l10n.t('Revspan: {message}', { message: errorText(hostL10n().t, errorPayload(error)) }));
            }
        }
    }
}
