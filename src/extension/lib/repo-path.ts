// Où est cloné le dépôt d'une PR sur le poste ? Une copie git de l'espace de travail (une racine ou l'un de ses
// dossiers) reconnue par l'une de ses remotes Bitbucket (<workspace>/<dépôt>), sinon par son nom de dossier ;
// plus les worktrees enregistrés par git pour ce dépôt, où qu'ils soient (dépôts bare compris).
// On privilégie une copie extraite sur la branche de la PR.
import path from 'node:path';

/** Ligne d'un fichier .git de worktree : « gitdir: <dossier git du worktree> ». */
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;
/** Contenu de HEAD quand une branche est extraite. */
const HEAD_REF = /^ref:\s*refs\/heads\/(.+?)\s*$/m;
/** Remote Bitbucket : https://[utilisateur@]bitbucket.org/…, ssh://git@bitbucket.org/…, git@bitbucket.org:… (.git facultatif). */
const BITBUCKET_REMOTE = /^(?:(?:https?|ssh):\/\/(?:[^@/\s]+@)?(?:www\.)?bitbucket\.org(?::\d+)?\/|[^@/\s:]+@bitbucket\.org:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
/** En-tête de section du fichier config de git (« [core] », « [remote "origin"] »). */
const SECTION = /^\s*\[\s*([A-Za-z]+)/;
const URL_LINE = /^\s*url\s*=\s*"?([^"\s]+)"?\s*$/i;
const BARE_LINE = /^\s*bare\s*=\s*true\s*$/i;

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

/** Dépôt Bitbucket recherché. */
export interface RepoTarget {
    workspace: string;
    repo: string;
}

/** Copie git : son dossier, son dossier git (.git ou dossier du worktree) et le dossier git commun du dépôt. */
interface GitCopy {
    dir: string;
    gitDir: string;
    commonDir: string;
}

interface GitConfig {
    remotes: RepoTarget[];
    bare: boolean;
}

/** « <workspace>/<dépôt> » d'une URL de remote Bitbucket, sinon null. */
export function bitbucketRepoOfRemote(url: string): RepoTarget | null {
    const match = BITBUCKET_REMOTE.exec(url.trim());
    return match ? { workspace: match[1] ?? '', repo: match[2] ?? '' } : null;
}

/** Dossier git d'une copie : son dossier .git, ou la cible de son fichier .git (worktree, dépôt bare à côté). */
function gitDirOf(dir: string, fs: RepoFs): string | null {
    const dotGit = path.join(dir, '.git');
    const pointer = fs.readText(dotGit);
    if (pointer === null) {
        return fs.exists(dotGit) ? dotGit : null;
    }
    const target = GITDIR_LINE.exec(pointer)?.[1];
    return target ? path.resolve(dir, target) : null;
}

/** Dossier git commun : fichier commondir d'un worktree ; à défaut …/<commun>/worktrees/<nom> ; sinon lui-même. */
function commonDirOf(gitDir: string, fs: RepoFs): string {
    const common = fs.readText(path.join(gitDir, 'commondir'))?.trim();
    if (common) {
        return path.resolve(gitDir, common);
    }
    const registry = path.dirname(gitDir);
    return path.basename(gitDir) !== '.git' && path.basename(registry) === 'worktrees' ? path.dirname(registry) : gitDir;
}

function copyAt(dir: string, fs: RepoFs): GitCopy | null {
    const gitDir = gitDirOf(dir, fs);
    return gitDir ? { dir, gitDir, commonDir: commonDirOf(gitDir, fs) } : null;
}

/** Copie principale d'un dépôt non bare (<copie>/.git), null pour un dépôt bare. */
function mainCopyDir(commonDir: string): string | null {
    return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
}

/** Nom du dépôt d'après son dossier git commun : <copie>/.git → copie, <nom>.git (bare) → nom, <nom>/.bare → nom. */
function repoNameOf(commonDir: string): string {
    const base = path.basename(commonDir);
    return base.startsWith('.') ? path.basename(path.dirname(commonDir)) : base.replace(/\.git$/i, '');
}

/** Remotes Bitbucket (toutes les sections [remote "…"]) et indicateur bare du fichier config commun. */
function readConfig(commonDir: string, fs: RepoFs): GitConfig {
    const config: GitConfig = { remotes: [], bare: false };
    let section = '';
    for (const line of (fs.readText(path.join(commonDir, 'config')) ?? '').split(/\r?\n/)) {
        const header = SECTION.exec(line);
        if (header) {
            section = (header[1] ?? '').toLowerCase();
            continue;
        }
        const url = section === 'remote' ? URL_LINE.exec(line)?.[1] : undefined;
        const remote = url ? bitbucketRepoOfRemote(url) : null;
        if (remote) {
            config.remotes.push(remote);
        }
        if (section === 'core' && BARE_LINE.test(line)) {
            config.bare = true;
        }
    }
    return config;
}

/** Worktrees enregistrés par git pour un dépôt (<commun>/worktrees/<nom>/gitdir → <worktree>/.git). */
function registeredWorktrees(commonDir: string, fs: RepoFs): string[] {
    const registry = path.join(commonDir, 'worktrees');
    return fs.listDirs(registry).flatMap((name) => {
        const target = fs.readText(path.join(registry, name, 'gitdir'))?.trim();
        return target ? [path.dirname(path.resolve(registry, name, target))] : [];
    });
}

/** Branche extraite dans une copie git (dossier .git, ou fichier .git d'un worktree). */
export function currentBranch(dir: string, fs: RepoFs): string | null {
    const gitDir = gitDirOf(dir, fs);
    const head = gitDir ? fs.readText(path.join(gitDir, 'HEAD')) : null;
    return head ? HEAD_REF.exec(head)?.[1] ?? null : null;
}

/** Copies git de l'espace de travail : chaque racine et ses dossiers (hors dossiers cachés). */
function workspaceCopies(roots: readonly string[], fs: RepoFs): GitCopy[] {
    const dirs = roots.flatMap((root) => [root, ...fs.listDirs(root).filter((name) => !name.startsWith('.')).map((name) => path.join(root, name))]);
    return [...new Set(dirs)].flatMap((dir) => copyAt(dir, fs) ?? []);
}

export function findLocalRepo(roots: readonly string[], target: RepoTarget, prBranch: string | null, fs: RepoFs): LocalRepo | null {
    const configs = new Map<string, GitConfig>();
    const configOf = (copy: GitCopy): GitConfig => {
        let config = configs.get(copy.commonDir);
        if (!config) {
            config = readConfig(copy.commonDir, fs);
            configs.set(copy.commonDir, config);
        }
        return config;
    };
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
    const copies = workspaceCopies(roots, fs);
    const byRemote = copies.filter((copy) => configOf(copy).remotes.some((r) => same(r.workspace, target.workspace) && same(r.repo, target.repo)));
    const byName = copies.filter((copy) => path.basename(copy.dir) === target.repo || repoNameOf(copy.commonDir) === target.repo);
    // Une remote <workspace>/<dépôt> exacte l'emporte sur un simple nom de dossier (dépôts homonymes, copie renommée).
    const matched = byRemote.length > 0 ? byRemote : byName;

    // Toutes les copies de ces dépôts : copie principale et worktrees enregistrés, sauf un dossier qui n'est qu'un dépôt bare.
    const found = new Map<string, GitCopy>();
    const add = (copy: GitCopy | null): void => {
        if (copy && !found.has(copy.dir) && !(copy.gitDir === copy.commonDir && configOf(copy).bare)) {
            found.set(copy.dir, copy);
        }
    };
    for (const copy of matched) {
        add(copy);
        const main = mainCopyDir(copy.commonDir);
        add(main === null ? null : copyAt(main, fs));
        registeredWorktrees(copy.commonDir, fs).forEach((dir) => add(copyAt(dir, fs)));
    }

    const repos = [...found.values()].map(({ dir }) => {
        const branch = currentBranch(dir, fs);
        return { dir, branch, onPrBranch: prBranch !== null && branch === prBranch };
    });
    return repos.find((r) => r.onPrBranch) ?? repos[0] ?? null;
}
