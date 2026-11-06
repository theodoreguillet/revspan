// « Ouvrir le fichier » : le fichier de la PR dans le dépôt cloné localement, à la ligne demandée.
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { PrRef } from '../shared/api.ts';
import type { PrService } from '../server/services/pr-service.ts';
import { findLocalRepo, type RepoFs } from './lib/repo-path.ts';

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
    const branch = await prs.detail(ref).then((d) => d.pr.sourceBranch, () => null);
    const repo = findLocalRepo(roots, ref.repo, branch, nodeFs);
    if (!repo) {
        void vscode.window.showWarningMessage(`Dépôt « ${ref.repo} » introuvable dans l'espace de travail (ni dossier ${ref.repo}, ni worktree).`);
        return;
    }
    const file = path.join(repo.dir, filePath);
    if (!fs.existsSync(file)) {
        void vscode.window.showWarningMessage(`« ${filePath} » n'existe pas dans ${repo.dir} (branche ${repo.branch ?? 'inconnue'}).`);
        return;
    }
    const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, selection: new vscode.Range(position, position) });
    if (!repo.onPrBranch) {
        void vscode.window.showInformationMessage(`Copie locale sur ${repo.branch ?? 'une autre branche'} : les lignes peuvent différer de la version de la PR.`);
    }
}
