// "Open file": the PR's file in the locally cloned repository, at the requested line.
import fs from 'node:fs';
import * as vscode from 'vscode';
import type { PrRef } from '../shared/api.ts';
import type { PrService } from '../server/services/pr-service.ts';
import { findLocalRepo, type RepoFs } from './lib/repo-path.ts';
import { plainMessageText } from './lib/plain-text.ts';
import { fileInRepo } from './lib/webview-messages.ts';

const nodeFs: RepoFs = {
    exists: (file) => fs.existsSync(file),
    readText: (file) => {
        try {
            return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
        } catch {
            return null;
        }
    },
    listDirs: (dir) => {
        try {
            return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch {
            return [];
        }
    },
};

export async function openLocalFile(prs: PrService, ref: PrRef, filePath: string, line: number | null): Promise<void> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const branch = await prs.sourceBranch(ref).catch(() => null);
    const repo = findLocalRepo(roots, ref, branch, nodeFs);
    if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t(
            'Repository “{repo}” not found in the workspace (no Bitbucket remote, no {folder} folder, no worktree).',
            { repo: plainMessageText(`${ref.workspace}/${ref.repo}`), folder: plainMessageText(ref.repo) },
        ));
        return;
    }
    const file = fileInRepo(repo.dir, filePath);
    if (!file) {
        void vscode.window.showWarningMessage(vscode.l10n.t('Path refused: “{path}” is outside the repository {dir}.', { path: plainMessageText(filePath), dir: plainMessageText(repo.dir) }));
        return;
    }
    if (!fs.existsSync(file)) {
        void vscode.window.showWarningMessage(repo.branch === null
            ? vscode.l10n.t('“{path}” doesn’t exist in {dir} (unknown branch).', { path: plainMessageText(filePath), dir: plainMessageText(repo.dir) })
            : vscode.l10n.t('“{path}” doesn’t exist in {dir} (branch {branch}).', { path: plainMessageText(filePath), dir: plainMessageText(repo.dir), branch: plainMessageText(repo.branch) }));
        return;
    }
    const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, selection: new vscode.Range(position, position) });
    if (!repo.onPrBranch) {
        void vscode.window.showInformationMessage(repo.branch === null
            ? vscode.l10n.t('The local copy is on another branch: lines may differ from the PR version.')
            : vscode.l10n.t('The local copy is on {branch}: lines may differ from the PR version.', { branch: plainMessageText(repo.branch) }));
    }
}
