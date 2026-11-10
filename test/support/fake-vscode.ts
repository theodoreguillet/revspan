// Fake "vscode" module (vi.mock('vscode', ...)): just what the panel, "Open file"
// and the "My PRs" view use, recording what the extension showed to the user.
import fs from 'node:fs';
import path from 'node:path';

type Listener<T> = (value: T) => unknown;

export class EventEmitter<T> {
    private readonly listeners = new Set<Listener<T>>();
    disposed = false;

    /** Like vscode.Event: the subscription is also added to `disposables` if provided. */
    readonly event = (listener: Listener<T>, thisArgs?: unknown, disposables?: { dispose(): unknown }[]): { dispose(): void } => {
        const bound: Listener<T> = (value) => listener.call(thisArgs, value);
        this.listeners.add(bound);
        const subscription = { dispose: () => void this.listeners.delete(bound) };
        disposables?.push(subscription);
        return subscription;
    };

    get listenerCount(): number {
        return this.listeners.size;
    }

    fire(value: T): void {
        this.listeners.forEach((listener) => listener(value));
    }

    dispose(): void {
        this.disposed = true;
        this.listeners.clear();
    }
}

export class Uri {
    readonly fsPath: string;

    private constructor(fsPath: string) {
        this.fsPath = fsPath;
    }

    static file(fsPath: string): Uri {
        return new Uri(fsPath);
    }

    static joinPath(base: Uri, ...parts: string[]): Uri {
        return new Uri(path.join(base.fsPath, ...parts));
    }

    toString(): string {
        return `file://${this.fsPath}`;
    }
}

export class Position {
    readonly line: number;
    readonly character: number;

    constructor(line: number, character: number) {
        this.line = line;
        this.character = character;
    }
}

export class Range {
    readonly start: Position;
    readonly end: Position;

    constructor(start: Position, end: Position) {
        this.start = start;
        this.end = end;
    }
}

export const ViewColumn = { Active: -1 };

/** Webview panel: messages posted to the page, attached listeners, closing. */
export class FakeWebviewPanel {
    readonly viewType: string;
    readonly options: unknown;
    title: string;
    iconPath: unknown = null;
    disposed = false;
    readonly posted: unknown[] = [];
    private readonly messages = new EventEmitter<unknown>();
    private readonly disposal = new EventEmitter<void>();
    readonly webview = {
        html: '',
        options: {} as unknown,
        cspSource: 'vscode-webview:',
        asWebviewUri: (uri: Uri): Uri => uri,
        postMessage: async (message: unknown): Promise<boolean> => {
            this.posted.push(message);
            return true;
        },
        onDidReceiveMessage: this.messages.event,
    };
    readonly onDidDispose = this.disposal.event;

    constructor(viewType: string, title: string, options: unknown = {}) {
        this.viewType = viewType;
        this.title = title;
        this.options = options;
    }

    reveal(): void {
        // nothing to do
    }

    dispose(): void {
        if (!this.disposed) {
            this.disposed = true;
            this.disposal.fire();
        }
    }

    /** Message sent by the page. */
    receive(message: unknown): void {
        this.messages.fire(message);
    }

    /** Listeners still attached to the panel (messages and closing). */
    get listenerCount(): number {
        return this.messages.listenerCount + this.disposal.listenerCount;
    }
}

/** What the extension did on the VS Code side. */
export const recorded = {
    panels: [] as FakeWebviewPanel[],
    warnings: [] as string[],
    errors: [] as string[],
    infos: [] as string[],
    opened: [] as string[],
    /** Commands run by the extension (vscode.commands.executeCommand). */
    commands: [] as { command: string; args: unknown[] }[],
};

export const commands = {
    async executeCommand(command: string, ...args: unknown[]): Promise<undefined> {
        recorded.commands.push({ command, args });
        return undefined;
    },
};

export const ConfigurationTarget = { Global: 1, Workspace: 2 };

interface SettingLevels {
    global?: unknown;
    workspace?: unknown;
}

/** Settings written by the extension, per level; defaults come from the manifest (as VS Code does). */
const settingLevels = new Map<string, SettingLevels>();
const manifest = JSON.parse(fs.readFileSync(new URL('../../extension/package.json', import.meta.url), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
};
const settingDefault = (id: string): unknown => manifest.contributes.configuration.properties[id]?.default;

export const workspace = {
    workspaceFolders: [] as { uri: Uri }[],
    isTrusted: true,
    /** Reads and writes the fake settings of a section (get, inspect, update). */
    getConfiguration(section: string) {
        const id = (key: string): string => `${section}.${key}`;
        return {
            get<T>(key: string): T | undefined {
                const levels = settingLevels.get(id(key));
                return (levels?.workspace ?? levels?.global ?? settingDefault(id(key))) as T | undefined;
            },
            inspect(key: string): { globalValue?: unknown; workspaceValue?: unknown } {
                const levels = settingLevels.get(id(key));
                return { globalValue: levels?.global, workspaceValue: levels?.workspace };
            },
            async update(key: string, value: unknown, target: number): Promise<void> {
                const levels = settingLevels.get(id(key)) ?? {};
                levels[target === ConfigurationTarget.Workspace ? 'workspace' : 'global'] = value;
                settingLevels.set(id(key), levels);
            },
        };
    },
};

export const window = {
    createWebviewPanel(viewType: string, title: string, _column: number, options: unknown): FakeWebviewPanel {
        const panel = new FakeWebviewPanel(viewType, title, options);
        recorded.panels.push(panel);
        return panel;
    },
    async showWarningMessage(message: string): Promise<undefined> {
        recorded.warnings.push(message);
        return undefined;
    },
    async showErrorMessage(message: string): Promise<undefined> {
        recorded.errors.push(message);
        return undefined;
    },
    async showInformationMessage(message: string): Promise<undefined> {
        recorded.infos.push(message);
        return undefined;
    },
    async showTextDocument(uri: Uri): Promise<void> {
        recorded.opened.push(uri.fsPath);
    },
};

/** VS Code's display language (vscode.env.language). */
export const env = { language: 'en' };

const frenchBundle = JSON.parse(fs.readFileSync(new URL('../../extension/l10n/bundle.l10n.fr.json', import.meta.url), 'utf8')) as Record<string, string>;

/** vscode.l10n.t: the extension's French bundle when VS Code is in French, `{name}` placeholders filled from args. */
export const l10n = {
    t(message: string, args: Record<string, string | number> = {}): string {
        const text = env.language === 'fr' ? frenchBundle[message] ?? message : message;
        return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in args ? String(args[name]) : match));
    },
};

export function resetFakeVscode(): void {
    for (const list of Object.values(recorded)) {
        list.length = 0;
    }
    workspace.workspaceFolders = [];
    workspace.isTrusted = true;
    settingLevels.clear();
    env.language = 'en';
}
