// Dossier de configuration, réglages et état local (fichiers JSON écrits de façon atomique, droits 0600).
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

/** État local d'une PR : marque « relue », fichiers vus, type de chaque version (clé = hash abrégé à 12). */
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

/** Dépôts valides (« workspace/dépôt »), sans doublon. */
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
            console.warn(`revspan: ${file} illisible, valeurs par défaut utilisées (${(error as Error).message})`);
        }
        return fallback;
    }
}

const completeState = (state: Partial<LocalPrState> = {}): LocalPrState => ({ ...state, viewed: state.viewed ?? {}, kinds: state.kinds ?? {} });

/** Liste des dépôts tenue ailleurs que dans config.json (extension VS Code : réglage revspan.repositories). */
export interface RepoSource {
    get(): readonly string[];
    set(repos: string[]): Promise<void>;
}

export class Store {
    readonly dir: string;
    private readonly configPath: string;
    private readonly statePath: string;
    private readonly repoSource: RepoSource | null;
    private configValue: AppConfig;
    private readonly state: StateFile;

    constructor(dir: string, { repoSource = null }: { repoSource?: RepoSource | null } = {}) {
        this.dir = dir;
        this.repoSource = repoSource;
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.configPath = path.join(dir, 'config.json');
        this.statePath = path.join(dir, 'state.json');
        this.configValue = { email: '', repos: [], ...readJson<Partial<AppConfig>>(this.configPath, {}) };
        this.state = { prs: {}, ...readJson<Partial<StateFile>>(this.statePath, {}) };
    }

    get config(): Readonly<AppConfig> {
        return this.repoSource ? { ...this.configValue, repos: normalizeRepos(this.repoSource.get()) } : this.configValue;
    }

    async saveConfig({ repos, ...rest }: Partial<AppConfig>): Promise<AppConfig> {
        if (repos !== undefined && this.repoSource) {
            await this.repoSource.set(repos);
        }
        this.configValue = { ...this.configValue, ...rest };
        if (repos !== undefined && !this.repoSource) {
            this.configValue.repos = repos;
        }
        writeJsonAtomic(this.configPath, this.configValue);
        return { ...this.config };
    }

    /** État local d'une PR (vide si elle n'a jamais été ouverte). */
    prState(prKey: string): LocalPrState {
        return completeState(this.state.prs[prKey]);
    }

    updatePrState(prKey: string, mutate: (state: LocalPrState) => void): void {
        const state = this.prState(prKey);
        mutate(state);
        this.state.prs[prKey] = state;
        writeJsonAtomic(this.statePath, this.state);
    }
}
