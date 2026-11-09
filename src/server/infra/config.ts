// Configuration folder, settings and local state (JSON files written atomically, mode 0600).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrRef, VersionKind } from '../../shared/api.ts';
import { parseRepoList } from '../../shared/repos.ts';
import type { LocalReview } from '../core/model.ts';

export interface AppConfig {
    email: string;
    repos: string[];
}

/** Local state of a PR: "reviewed" mark, seen files, type of each version (key = hash abbreviated to 12). */
export interface LocalPrState extends LocalReview {
    kinds: Record<string, VersionKind>;
}

interface StateFile {
    prs: Record<string, Partial<LocalPrState>>;
}

export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
    if (env.REVSPAN_CONFIG_DIR) {
        return env.REVSPAN_CONFIG_DIR;
    }
    if (platform === 'win32') {
        return path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'revspan');
    }
    return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'revspan');
}

/** Valid repositories ("workspace/repo"), without duplicates. */
export const normalizeRepos = (repos: readonly string[]): string[] => parseRepoList(repos).repos;

export const prKeyOf = ({ workspace, repo, id }: PrRef): string => `${workspace}/${repo}#${id}`;

export function writeJsonAtomic(file: string, value: unknown): void {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`revspan: ${file} unreadable, defaults used (${(error as Error).message})`);
        }
        return fallback;
    }
}

/** Signature of a file (inode, date, size): atomic writing changes the inode, so any rewrite is detected. */
function signatureOf(file: string): string {
    try {
        const { ino, mtimeMs, size } = fs.statSync(file);
        return `${ino}:${mtimeMs}:${size}`;
    } catch {
        return 'absent';
    }
}

/** JSON file re-read only when it changed on disk (several windows share the same folder). */
class JsonFile<T> {
    private signature: string | null = null;
    private cached: T;
    private readonly file: string;
    private readonly load: (raw: unknown) => T;

    constructor(file: string, load: (raw: unknown) => T) {
        this.file = file;
        this.load = load;
        this.cached = load({});
    }

    /** Up-to-date value: re-read if the file changed since the last read, defaults if it is missing or corrupt. */
    read(): T {
        const signature = signatureOf(this.file);
        if (signature !== this.signature) {
            this.cached = this.load(readJson<unknown>(this.file, {}));
            this.signature = signature;
        }
        return this.cached;
    }

    write(value: T): void {
        writeJsonAtomic(this.file, value);
        this.cached = value;
        this.signature = signatureOf(this.file);
    }
}

/** Copy of a PR state, nested records included: a mutation does not reach the cached file until it is written. */
const completeState = (state: Partial<LocalPrState> = {}): LocalPrState => ({ ...state, viewed: { ...state.viewed }, kinds: { ...state.kinds } });

/** Repository list kept somewhere other than config.json (VS Code extension: revspan.repositories setting). */
export interface RepoSource {
    get(): readonly string[];
    set(repos: string[]): Promise<void>;
}

export class Store {
    readonly dir: string;
    private readonly repoSource: RepoSource | null;
    private readonly configFile: JsonFile<AppConfig>;
    private readonly stateFile: JsonFile<StateFile>;

    constructor(dir: string, { repoSource = null }: { repoSource?: RepoSource | null } = {}) {
        this.dir = dir;
        this.repoSource = repoSource;
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.configFile = new JsonFile(path.join(dir, 'config.json'), (raw) => ({ email: '', repos: [], ...(raw as Partial<AppConfig>) }));
        this.stateFile = new JsonFile(path.join(dir, 'state.json'), (raw) => ({ prs: {}, ...(raw as Partial<StateFile>) }));
    }

    get config(): Readonly<AppConfig> {
        const value = this.configFile.read();
        return this.repoSource ? { ...value, repos: normalizeRepos(this.repoSource.get()) } : value;
    }

    async saveConfig({ repos, ...rest }: Partial<AppConfig>): Promise<AppConfig> {
        if (repos !== undefined && this.repoSource) {
            await this.repoSource.set(repos);
        }
        const next = { ...this.configFile.read(), ...rest };
        if (repos !== undefined && !this.repoSource) {
            next.repos = repos;
        }
        this.configFile.write(next);
        return { ...this.config };
    }

    /** Local state of a PR (empty if it was never opened). */
    prState(prKey: string): LocalPrState {
        return completeState(this.stateFile.read().prs[prKey]);
    }

    updatePrState(prKey: string, mutate: (state: LocalPrState) => void): void {
        const file = this.stateFile.read();
        const state = completeState(file.prs[prKey]);
        mutate(state);
        this.stateFile.write({ ...file, prs: { ...file.prs, [prKey]: state } });
    }
}
