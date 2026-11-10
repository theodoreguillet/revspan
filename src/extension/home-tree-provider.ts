// "My PRs" view of the side bar.
import * as vscode from 'vscode';
import type { HomeGroupKey } from '../shared/api.ts';
import type { HomeService } from '../server/services/home-service.ts';
import { visibleGroups } from '../shared/home-filter.ts';
import { AppError, errorPayload } from '../server/errors.ts';
import { hostL10n } from './host-l10n.ts';
import { errorText } from './lib/error-text.ts';
import type { Grouping } from '../shared/home-grouping.ts';
import { buildHomeTree, hiddenLabel, repoErrorLabel, truncatedLabel, type GroupNode, type PrNode, type SubgroupNode } from './lib/home-tree.ts';

export type Node =
    | { kind: 'group'; group: GroupNode }
    | { kind: 'subgroup'; parent: HomeGroupKey; subgroup: SubgroupNode }
    | { kind: 'pr'; pr: PrNode }
    /** icon: codicon (warning by default); command: run on click. */
    | { kind: 'message'; text: string; icon?: string; command?: string };

/** Context keys of the view's welcome messages (viewsWelcome): token to configure, no tracked repository. */
export const NEEDS_TOKEN_CONTEXT = 'revspan.needsToken';
export const NO_REPOS_CONTEXT = 'revspan.noRepos';

export class HomeTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly home: HomeService;
    private readonly changed = new vscode.EventEmitter<void>();
    private fresh = false;
    readonly onDidChangeTreeData = this.changed.event;

    private readonly grouping: () => Grouping;

    /** grouping: the user's current choice, read at each refresh. */
    constructor(home: HomeService, grouping: () => Grouping) {
        this.home = home;
        this.grouping = grouping;
    }

    /** fresh: ignores the home page's short cache ("Refresh" button). */
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
        if (node.kind === 'subgroup') {
            const item = new vscode.TreeItem(node.subgroup.label, vscode.TreeItemCollapsibleState.Expanded);
            item.id = `subgroup:${node.parent}:${node.subgroup.key}`;
            return item;
        }
        if (node.kind === 'message') {
            const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon(node.icon ?? 'warning');
            if (node.command) {
                item.command = { command: node.command, title: node.text };
            }
            return item;
        }
        const item = new vscode.TreeItem(node.pr.label, vscode.TreeItemCollapsibleState.None);
        item.id = `pr:${node.pr.ref.workspace}/${node.pr.ref.repo}/${node.pr.ref.id}`;
        item.description = node.pr.description;
        item.tooltip = node.pr.tooltip;
        item.contextValue = node.pr.contextValue;
        if (node.pr.icon) {
            item.iconPath = new vscode.ThemeIcon(node.pr.icon);
        }
        item.command = { command: 'revspan.openPr', title: vscode.l10n.t('Open the PR'), arguments: [node.pr.ref] };
        return item;
    }

    async getChildren(node?: Node): Promise<Node[]> {
        if (node?.kind === 'group') {
            return [
                ...node.group.subgroups.map((subgroup): Node => ({ kind: 'subgroup', parent: node.group.key, subgroup })),
                ...node.group.prs.map((pr): Node => ({ kind: 'pr', pr })),
            ];
        }
        if (node?.kind === 'subgroup') {
            return node.subgroup.prs.map((pr) => ({ kind: 'pr', pr }));
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
            const cut = home.truncated.map((t): Node => ({ kind: 'message', text: truncatedLabel(l10n.t, t) }));
            const { hidden } = visibleGroups(home);
            const hiddenNote: Node[] = hidden > 0 ? [{ kind: 'message', text: hiddenLabel(l10n, hidden), icon: 'eye-closed', command: 'revspan.openSettings' }] : [];
            return [...errors, ...cut, ...hiddenNote, ...buildHomeTree(home, l10n, this.grouping()).map((group): Node => ({ kind: 'group', group }))];
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
