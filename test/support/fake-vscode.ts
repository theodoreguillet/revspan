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

/** Input of a webview tab (VS Code prefixes the panel's view type, e.g. "mainThreadWebview-revspan"). */
export class TabInputWebview {
    readonly viewType: string;

    constructor(viewType: string) {
        this.viewType = viewType;
    }
}

export interface FakeTab {
    readonly label: string;
    readonly input: unknown;
    readonly group: FakeTabGroup;
}

export class FakeTabGroup {
    readonly viewColumn: number;
    readonly tabs: FakeTab[] = [];

    constructor(viewColumn: number) {
        this.viewColumn = viewColumn;
    }
}

/** Webview panel: messages posted to the page, attached listeners, visibility, closing. */
export class FakeWebviewPanel {
    readonly viewType: string;
    readonly options: unknown;
    title: string;
    iconPath: unknown = null;
    disposed = false;
    /** On screen (a new panel opens in the active editor group, in front). */
    visible = true;
    /** Times the extension brought it to the front. */
    revealed = 0;
    readonly posted: unknown[] = [];
    private readonly messages = new EventEmitter<unknown>();
    private readonly disposal = new EventEmitter<void>();
    private readonly viewState = new EventEmitter<{ webviewPanel: FakeWebviewPanel }>();
    /** Editor group (column) of its tab. */
    viewColumn = 1;
    /** Removes its tab from the editor group when it closes (panels created by createWebviewPanel). */
    closeTab: (() => void) | null = null;
    private readonly page = {
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
    /** Like VS Code, the webview can no longer be used once the panel is closed. */
    get webview(): typeof this.page {
        if (this.disposed) {
            throw new Error('Webview is disposed');
        }
        return this.page;
    }

    readonly onDidDispose = this.disposal.event;
    readonly onDidChangeViewState = this.viewState.event;

    constructor(viewType: string, title: string, options: unknown = {}) {
        this.viewType = viewType;
        this.title = title;
        this.options = options;
    }

    reveal(): void {
        this.revealed++;
        this.setVisible(true);
    }

    /** The user shows or hides the tab (another tab in front, editor group closed...). */
    setVisible(visible: boolean): void {
        if (this.visible !== visible) {
            this.visible = visible;
            this.viewState.fire({ webviewPanel: this });
        }
    }

    dispose(): void {
        if (!this.disposed) {
            this.disposed = true;
            this.closeTab?.();
            this.disposal.fire();
        }
    }

    /** Message sent by the page. */
    receive(message: unknown): void {
        this.messages.fire(message);
    }

    /** Listeners still attached to the panel (messages, visibility and closing). */
    get listenerCount(): number {
        return this.messages.listenerCount + this.disposal.listenerCount + this.viewState.listenerCount;
    }
}

/** What the extension did on the VS Code side. */
export const recorded = {
    panels: [] as FakeWebviewPanel[],
    /** Tabs closed by the extension (tabGroups.close). */
    closedTabs: [] as FakeTab[],
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
/**
 * Settings VS Code does not know, as after an update of the extension without "Reload Window" (the old manifest stays
 * loaded): a write fails like VS Code's and inspect() gives no default.
 */
export const unregisteredSettings = new Set<string>();
/** Error every write throws while set (settings.json with errors, file system...). */
export const settingWrites: { failure: Error | null } = { failure: null };
const registered = (id: string): boolean => !unregisteredSettings.has(id) && id in manifest.contributes.configuration.properties;

export const workspace = {
    workspaceFolders: [] as { uri: Uri }[],
    isTrusted: true,
    /** Reads and writes the fake settings of a section (get, inspect, update). */
    getConfiguration(section: string) {
        const id = (key: string): string => `${section}.${key}`;
        return {
            get<T>(key: string): T | undefined {
                const levels = settingLevels.get(id(key));
                // An unregistered setting has no default (VS Code does not know it): undefined when unset.
                return (levels?.workspace ?? levels?.global ?? (registered(id(key)) ? settingDefault(id(key)) : undefined)) as T | undefined;
            },
            inspect(key: string): { defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown } {
                const levels = settingLevels.get(id(key));
                return { defaultValue: registered(id(key)) ? settingDefault(id(key)) : undefined, globalValue: levels?.global, workspaceValue: levels?.workspace };
            },
            async update(key: string, value: unknown, target: number): Promise<void> {
                if (settingWrites.failure) {
                    throw settingWrites.failure;
                }
                if (!registered(id(key))) {
                    const level = target === ConfigurationTarget.Workspace ? 'Workspace Settings' : 'User Settings';
                    throw new Error(`Unable to write to ${level} because ${id(key)} is not a registered configuration.`);
                }
                const levels = settingLevels.get(id(key)) ?? {};
                levels[target === ConfigurationTarget.Workspace ? 'workspace' : 'global'] = value;
                settingLevels.set(id(key), levels);
            },
        };
    },
};

function tabGroup(viewColumn: number): FakeTabGroup {
    const existing = window.tabGroups.all.find((group) => group.viewColumn === viewColumn);
    if (existing) {
        return existing;
    }
    const group = new FakeTabGroup(viewColumn);
    window.tabGroups.all.push(group);
    return group;
}

/** A Revspan tab reopened by VS Code after a reload but not revived yet: a tab, no panel. */
export function dormantTab(label: string, viewColumn = 1, viewType = 'mainThreadWebview-revspan'): FakeTab {
    const group = tabGroup(viewColumn);
    const tab: FakeTab = { label, input: new TabInputWebview(viewType), group };
    group.tabs.push(tab);
    return tab;
}

export const window = {
    createWebviewPanel(viewType: string, title: string, column: number, options: unknown): FakeWebviewPanel {
        const panel = new FakeWebviewPanel(viewType, title, options);
        panel.viewColumn = column === ViewColumn.Active ? 1 : column;
        const group = tabGroup(panel.viewColumn);
        const tab: FakeTab = { get label() { return panel.title; }, input: new TabInputWebview(`mainThreadWebview-${viewType}`), group };
        group.tabs.push(tab);
        panel.closeTab = () => group.tabs.splice(group.tabs.indexOf(tab), 1);
        recorded.panels.push(panel);
        return panel;
    },
    tabGroups: {
        all: [] as FakeTabGroup[],
        async close(tab: FakeTab): Promise<boolean> {
            tab.group.tabs.splice(tab.group.tabs.indexOf(tab), 1);
            recorded.closedTabs.push(tab);
            return true;
        },
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
    window.tabGroups.all = [];
    workspace.isTrusted = true;
    settingLevels.clear();
    unregisteredSettings.clear();
    settingWrites.failure = null;
    env.language = 'en';
}
