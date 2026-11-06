// Où est cloné le dépôt d'une PR sur le poste ? Copie <racine>/<dépôt> (ou racine elle-même), plus ses worktrees
// enregistrés par git, où qu'ils soient. On privilégie une copie extraite sur la branche de la PR.
import path from 'node:path';

/** Ligne d'un fichier .git de worktree : « gitdir: <copie principale>/.git/worktrees/<nom> ». */
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;
/** Contenu de HEAD quand une branche est extraite. */
const HEAD_REF = /^ref:\s*refs\/heads\/(.+?)\s*$/m;

/** Accès disque minimal (injectable pour les tests). */
export interface RepoFs {
    exists(file: string): boolean;
    readText(file: string): string | null;
    listDirs(dir: string): string[];
}

export interface LocalRepo {
    dir: string;
    /** Branche actuellement extraite (null si illisible). */
    branch: string | null;
    /** La copie est sur la branche de la PR (les lignes correspondent à la dernière version). */
    onPrBranch: boolean;
}

/** Dossier git d'un worktree (cible de son fichier .git), null pour une copie principale. */
function worktreeGitDir(dir: string, fs: RepoFs): string | null {
    const pointer = fs.readText(path.join(dir, '.git'));
    const gitdir = pointer === null ? undefined : GITDIR_LINE.exec(pointer)?.[1];
    return gitdir ? path.resolve(dir, gitdir) : null;
}

/** Copie principale dont `dir` est un worktree (…/<copie>/.git/worktrees/<nom>), sinon null. */
function mainCopyOf(dir: string, fs: RepoFs): string | null {
    const gitdir = worktreeGitDir(dir, fs);
    if (!gitdir) {
        return null;
    }
    const registry = path.dirname(gitdir);
    const dotGit = path.dirname(registry);
    return path.basename(registry) === 'worktrees' && path.basename(dotGit) === '.git' ? path.dirname(dotGit) : null;
}

/** Worktrees enregistrés par git pour une copie principale (<copie>/.git/worktrees/<nom>/gitdir → <worktree>/.git). */
function registeredWorktrees(dir: string, fs: RepoFs): string[] {
    const registry = path.join(dir, '.git', 'worktrees');
    return fs.listDirs(registry).flatMap((name) => {
        const target = fs.readText(path.join(registry, name, 'gitdir'))?.trim();
        return target ? [path.dirname(path.resolve(dir, target))] : [];
    });
}

/** Branche extraite dans une copie git (dossier .git, ou fichier .git d'un worktree). */
export function currentBranch(dir: string, fs: RepoFs): string | null {
    const pointer = fs.readText(path.join(dir, '.git'));
    const gitdir = pointer === null ? path.join(dir, '.git') : worktreeGitDir(dir, fs);
    const head = gitdir ? fs.readText(path.join(gitdir, 'HEAD')) : null;
    return head ? HEAD_REF.exec(head)?.[1] ?? null : null;
}

function candidates(roots: readonly string[], repo: string, fs: RepoFs): string[] {
    const found: string[] = [];
    const add = (dir: string): void => {
        if (!found.includes(dir) && fs.exists(path.join(dir, '.git'))) {
            found.push(dir);
        }
    };
    for (const root of roots) {
        const main = mainCopyOf(root, fs);
        if (path.basename(root) === repo || (main !== null && path.basename(main) === repo)) {
            add(root);
        }
        if (main !== null && path.basename(main) === repo) {
            add(main);
        }
        add(path.join(root, repo));
    }
    for (const dir of [...found]) {
        registeredWorktrees(dir, fs).forEach(add);
    }
    return found;
}

export function findLocalRepo(roots: readonly string[], repo: string, prBranch: string | null, fs: RepoFs): LocalRepo | null {
    const repos = candidates(roots, repo, fs).map((dir) => {
        const branch = currentBranch(dir, fs);
        return { dir, branch, onPrBranch: prBranch !== null && branch === prBranch };
    });
    return repos.find((r) => r.onPrBranch) ?? repos[0] ?? null;
}
