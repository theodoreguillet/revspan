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
import { plainMessageText } from './lib/plain-text.ts';
import { PANEL_VIEW_TYPE, panelTitle, roleTitles, routeOfApiRead, screenOfRoute } from './lib/panel-route.ts';
import { buildWebviewHtml } from './lib/webview-html.ts';
import { parseWebviewMessage } from './lib/webview-messages.ts';
import { openLocalFile } from './local-files.ts';

/** Tab title of a page route, in VS Code's display language. */
const titleOf = (route: string): string => panelTitle(hostL10n().t, route);

/** A Revspan tab: its role, fixed when it opens (home page and settings, or one PR). */
interface Tab {
    readonly role: PanelRole;
    readonly panel: vscode.WebviewPanel;
    /** Closed by the user: its webview can no longer be used (VS Code throws). */
    closed: boolean;
}

/** Whether a VS Code tab holds a Revspan webview (VS Code prefixes the view type, e.g. "mainThreadWebview-revspan"). */
const isRevspanTab = (tab: vscode.Tab): boolean => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(PANEL_VIEW_TYPE);

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
        const role = roleOfRoute(route);
        const tab = this.tabs.get(role);
        if (tab) {
            tab.panel.reveal();
            // The "Revspan" tab goes to the asked screen (a push to the current route does nothing); an open PR keeps
            // its range unless one is asked.
            if (role === 'home' || route !== screenOfRoute(route)) {
                tab.panel.title = titleOf(route);
                void this.post(tab, { type: 'navigate', route });
            }
            return;
        }
        // A tab of that role reopened after a reload but not revived yet (VS Code revives a tab when it is first shown):
        // replaced in its place, not duplicated.
        const dormant = this.dormantTab(route);
        const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, titleOf(route), dormant?.group.viewColumn ?? vscode.ViewColumn.Active, {
            ...this.webviewOptions(),
            retainContextWhenHidden: true,
        });
        this.attach(panel, route);
        if (dormant) {
            // the new tab is already there: a dormant tab VS Code refuses to close only stays as a duplicate
            vscode.window.tabGroups.close(dormant, true).then(undefined, (error: unknown) => {
                console.warn(`revspan: cannot close the restored tab (${(error as Error).message ?? String(error)})`);
            });
        }
    }

    /**
     * Revspan tab of the role of `route` that VS Code shows but has not revived (no panel yet), found by its title.
     * A tab with the title and column of a live panel is left alone (two workspaces can have the same PR title).
     */
    private dormantTab(route: string): vscode.Tab | undefined {
        const titles = roleTitles(hostL10n().t, route);
        const live = [...this.tabs.values()].map(({ panel }) => panel);
        return vscode.window.tabGroups.all
            .flatMap((group) => group.tabs)
            .find((tab) => isRevspanTab(tab) && titles.includes(tab.label)
                && !live.some((panel) => panel.title === tab.label && panel.viewColumn === tab.group.viewColumn));
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
        const tab: Tab = { role: roleOfRoute(route), panel, closed: false };
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
            tab.closed = true;
            if (this.tabs.get(tab.role) === tab) {
                this.tabs.delete(tab.role);
            }
            listeners.forEach((listener) => listener.dispose());
        }, undefined, listeners);
        this.tabs.set(tab.role, tab);
        // Delivered once the page is loaded: a tab revived in the background starts paused.
        void this.post(tab, { type: 'visibility', visible: panel.visible });
    }

    /** Message to the tab's page; nothing once the tab is closed (e.g. a response arriving after the user closed it). */
    private post(tab: Tab, message: HostToWebview): Thenable<boolean> {
        return tab.closed ? Promise.resolve(false) : tab.panel.webview.postMessage(message);
    }

    private async handle(tab: Tab, message: WebviewToHost): Promise<void> {
        try {
            switch (message.type) {
                case 'request': {
                    // Title updated as soon as requested: the following reads follow the navigation order in the page.
                    // Only a screen of the tab's role counts (a PR tab keeps its title whatever it reads).
                    const route = routeOfApiRead(message.method, message.path);
                    if (route && roleOfRoute(route) === tab.role) {
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
                void vscode.window.showErrorMessage(vscode.l10n.t('Revspan: {message}', { message: plainMessageText(errorText(hostL10n().t, errorPayload(error))) }));
            }
        }
    }
}
