// Where is a PR's repository cloned on this machine? A git copy of the workspace (a root or one of its
// folders) recognized by one of its Bitbucket remotes (<workspace>/<repo>), otherwise by its folder name;
// plus the worktrees registered by git for this repository, wherever they are (bare repositories included).
// A copy checked out on the PR's branch is preferred.
import path from 'node:path';

/** Line of a worktree's .git file: "gitdir: <worktree git folder>". */
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;
/** Content of HEAD when a branch is checked out. */
const HEAD_REF = /^ref:\s*refs\/heads\/(.+?)\s*$/m;
/** Bitbucket remote: https://[user@]bitbucket.org/..., ssh://git@bitbucket.org/..., git@bitbucket.org:... (.git optional). */
const BITBUCKET_REMOTE = /^(?:(?:https?|ssh):\/\/(?:[^@/\s]+@)?(?:www\.)?bitbucket\.org(?::\d+)?\/|[^@/\s:]+@bitbucket\.org:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
/** Section header of git's config file ("[core]", "[remote "origin"]"). */
const SECTION = /^\s*\[\s*([A-Za-z]+)/;
const URL_LINE = /^\s*url\s*=\s*"?([^"\s]+)"?\s*$/i;
const BARE_LINE = /^\s*bare\s*=\s*true\s*$/i;

/** Minimal disk access (injectable for tests). */
export interface RepoFs {
    exists(file: string): boolean;
    readText(file: string): string | null;
    listDirs(dir: string): string[];
}

export interface LocalRepo {
    dir: string;
    /** Branch currently checked out (null if unreadable). */
    branch: string | null;
    /** The copy is on the PR's branch (lines match the latest version). */
    onPrBranch: boolean;
}

/** Bitbucket repository being looked for. */
export interface RepoTarget {
    workspace: string;
    repo: string;
}

/** Git copy: its folder, its git folder (.git or the worktree's folder) and the repository's common git folder. */
interface GitCopy {
    dir: string;
    gitDir: string;
    commonDir: string;
}

interface GitConfig {
    remotes: RepoTarget[];
    bare: boolean;
}

/** "<workspace>/<repo>" of a Bitbucket remote URL, otherwise null. */
export function bitbucketRepoOfRemote(url: string): RepoTarget | null {
    const match = BITBUCKET_REMOTE.exec(url.trim());
    return match ? { workspace: match[1] ?? '', repo: match[2] ?? '' } : null;
}

/** Git folder of a copy: its .git folder, or the target of its .git file (worktree, bare repository next to it). */
function gitDirOf(dir: string, fs: RepoFs): string | null {
    const dotGit = path.join(dir, '.git');
    const pointer = fs.readText(dotGit);
    if (pointer === null) {
        return fs.exists(dotGit) ? dotGit : null;
    }
    const target = GITDIR_LINE.exec(pointer)?.[1];
    return target ? path.resolve(dir, target) : null;
}

/** Common git folder: a worktree's commondir file; failing that .../<common>/worktrees/<name>; otherwise itself. */
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

/** Main copy of a non-bare repository (<copy>/.git), null for a bare repository. */
function mainCopyDir(commonDir: string): string | null {
    return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
}

/** Repository name from its common git folder: <copy>/.git -> copy, <name>.git (bare) -> name, <name>/.bare -> name. */
function repoNameOf(commonDir: string): string {
    const base = path.basename(commonDir);
    return base.startsWith('.') ? path.basename(path.dirname(commonDir)) : base.replace(/\.git$/i, '');
}

/** Bitbucket remotes (all [remote "..."] sections) and bare flag from the common config file. */
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

/** Worktrees registered by git for a repository (<common>/worktrees/<name>/gitdir -> <worktree>/.git). */
function registeredWorktrees(commonDir: string, fs: RepoFs): string[] {
    const registry = path.join(commonDir, 'worktrees');
    return fs.listDirs(registry).flatMap((name) => {
        const target = fs.readText(path.join(registry, name, 'gitdir'))?.trim();
        return target ? [path.dirname(path.resolve(registry, name, target))] : [];
    });
}

/** Branch checked out in a git copy (.git folder, or a worktree's .git file). */
export function currentBranch(dir: string, fs: RepoFs): string | null {
    const gitDir = gitDirOf(dir, fs);
    const head = gitDir ? fs.readText(path.join(gitDir, 'HEAD')) : null;
    return head ? HEAD_REF.exec(head)?.[1] ?? null : null;
}

/** Git copies of the workspace: each root and its folders (hidden folders excluded). */
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
    // An exact <workspace>/<repo> remote wins over a plain folder name (homonymous repositories, renamed copy).
    const matched = byRemote.length > 0 ? byRemote : byName;

    // All the copies of these repositories: main copy and registered worktrees, except a folder that is only a bare repository.
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
