// Entry point of the Revspan VS Code extension.
import * as vscode from 'vscode';
import type { PrRef } from '../shared/api.ts';
import { parsePrUrl } from '../shared/pr-url.ts';
import { createExtensionApp, REPOS_SETTING } from './app-context.ts';
import { DiffDocuments } from './diff-documents.ts';
import { withFollowed } from '../shared/follow.ts';
import { GROUPINGS, isGrouping, type Grouping } from '../shared/home-grouping.ts';
import { hostL10n } from './host-l10n.ts';
import { HomeTreeProvider, type Node } from './home-tree-provider.ts';
import { errorText } from './lib/error-text.ts';
import { errorPayload } from '../server/errors.ts';
import { DIFF_SCHEME } from './lib/diff-uri.ts';
import { PANEL_VIEW_TYPE, restoredRoute } from './lib/panel-route.ts';
import { RevspanPanel } from './panel.ts';

/** Key of the grouping choice in the extension's global state. */
const GROUPING_KEY = 'revspan.grouping';
const DEFAULT_GROUPING: Grouping = 'repository';

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

function groupingLabel(grouping: Grouping): string {
    switch (grouping) {
        case 'repository':
            return vscode.l10n.t('Repository');
        case 'contributor':
            return vscode.l10n.t('Contributor');
        case 'none':
            return vscode.l10n.t('None');
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const app = await createExtensionApp(context);
    const currentGrouping = (): Grouping => {
        const stored = context.globalState.get<unknown>(GROUPING_KEY);
        return isGrouping(stored) ? stored : DEFAULT_GROUPING;
    };
    const tree = new HomeTreeProvider(app.services.home, currentGrouping);

    async function chooseGrouping(): Promise<void> {
        const current = currentGrouping();
        const items = GROUPINGS.map((grouping) => ({ label: groupingLabel(grouping), description: grouping === current ? vscode.l10n.t('current') : '', grouping }));
        const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Group by…'), placeHolder: vscode.l10n.t('How to split “To do” and “Other open PRs”') });
        if (picked) {
            await context.globalState.update(GROUPING_KEY, picked.grouping);
            tree.refresh();
        }
    }

    /** Follows or unfollows the author of a PR node, through the review settings (same path as the page). */
    async function setFollow(node: Node | undefined, follow: boolean): Promise<void> {
        const author = node?.kind === 'pr' ? node.pr.author : null;
        if (!author) {
            return;
        }
        try {
            const { followed } = app.services.settings.followed();
            await app.services.settings.update({ review: { followed: withFollowed(followed, { uuid: author.uuid, displayName: author.displayName }, follow) } });
        } catch (error) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Revspan: {message}', { message: errorText(hostL10n().t, errorPayload(error)) }));
        }
        tree.refresh({ fresh: true });
    }

    const diffs = new DiffDocuments(app.services.prs);
    const panel = new RevspanPanel({ context, app, diffs, onWrite: () => tree.refresh() });

    context.subscriptions.push(
        tree,
        vscode.window.registerTreeDataProvider('revspan.home', tree),
        vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
        // After "Reload Window", VS Code reopens the panel with the state saved by the page (its route).
        vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
            deserializeWebviewPanel: async (webviewPanel, state: unknown) => panel.restore(webviewPanel, restoredRoute(state)),
        }),
        vscode.commands.registerCommand('revspan.openHome', () => panel.show('/')),
        vscode.commands.registerCommand('revspan.openSettings', () => panel.show('/settings')),
        vscode.commands.registerCommand('revspan.refresh', () => tree.refresh({ fresh: true })),
        vscode.commands.registerCommand('revspan.groupBy', chooseGrouping),
        vscode.commands.registerCommand('revspan.followAuthor', (node?: Node) => setFollow(node, true)),
        vscode.commands.registerCommand('revspan.unfollowAuthor', (node?: Node) => setFollow(node, false)),
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
    // Nothing to release: everything is registered in context.subscriptions.
}
