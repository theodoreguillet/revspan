// Vue « Mes PR » de la barre latérale.
import * as vscode from 'vscode';
import type { HomeService } from '../server/services/home-service.ts';
import { AppError, errorPayload } from '../server/errors.ts';
import { hostL10n } from './host-l10n.ts';
import { errorText } from './lib/error-text.ts';
import { buildHomeTree, repoErrorLabel, type GroupNode, type PrNode } from './lib/home-tree.ts';

type Node = { kind: 'group'; group: GroupNode } | { kind: 'pr'; pr: PrNode } | { kind: 'message'; text: string };

/** Clés de contexte des messages d'accueil de la vue (viewsWelcome) : jeton à configurer, aucun dépôt suivi. */
export const NEEDS_TOKEN_CONTEXT = 'revspan.needsToken';
export const NO_REPOS_CONTEXT = 'revspan.noRepos';

export class HomeTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly home: HomeService;
    private readonly changed = new vscode.EventEmitter<void>();
    private fresh = false;
    readonly onDidChangeTreeData = this.changed.event;

    constructor(home: HomeService) {
        this.home = home;
    }

    /** fresh : ignore le cache court de l'accueil (bouton « Actualiser »). */
    refresh({ fresh = false } = {}): void {
        this.fresh = this.fresh || fresh;
        this.changed.fire();
    }

    dispose(): void {
        this.changed.dispose();
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'group') {
            const item = new vscode.TreeItem(node.group.label, node.group.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = new vscode.ThemeIcon(node.group.icon);
            item.id = `group:${node.group.key}`;
            return item;
        }
        if (node.kind === 'message') {
            const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('warning');
            return item;
        }
        const item = new vscode.TreeItem(node.pr.label, vscode.TreeItemCollapsibleState.None);
        item.id = `pr:${node.pr.ref.workspace}/${node.pr.ref.repo}/${node.pr.ref.id}`;
        item.description = node.pr.description;
        item.tooltip = node.pr.tooltip;
        item.command = { command: 'revspan.openPr', title: vscode.l10n.t('Open the PR'), arguments: [node.pr.ref] };
        return item;
    }

    async getChildren(node?: Node): Promise<Node[]> {
        if (node?.kind === 'group') {
            return node.group.prs.map((pr) => ({ kind: 'pr', pr }));
        }
        if (node) {
            return [];
        }
        try {
            const fresh = this.fresh;
            this.fresh = false;
            const home = await this.home.get({ fresh });
            await vscode.commands.executeCommand('setContext', NEEDS_TOKEN_CONTEXT, false);
            await vscode.commands.executeCommand('setContext', NO_REPOS_CONTEXT, home.repos.length === 0);
            const l10n = hostL10n();
            const errors = home.errors.map((e): Node => ({ kind: 'message', text: repoErrorLabel(l10n.t, e) }));
            return [...errors, ...buildHomeTree(home, l10n).map((group): Node => ({ kind: 'group', group }))];
        } catch (error) {
            if (error instanceof AppError && (error.code === 'NO_TOKEN' || error.code === 'BB_UNAUTHORIZED')) {
                await vscode.commands.executeCommand('setContext', NEEDS_TOKEN_CONTEXT, true);
                await vscode.commands.executeCommand('setContext', NO_REPOS_CONTEXT, false);
                return [];
            }
            return [{ kind: 'message', text: errorText(hostL10n().t, errorPayload(error)) }];
        }
    }
}
