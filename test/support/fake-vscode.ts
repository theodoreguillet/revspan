// Faux module « vscode » (vi.mock('vscode', …)) : juste ce qu'utilisent le panneau, « Ouvrir le fichier »
// et la vue « Mes PR », avec l'enregistrement de ce que l'extension a montré à l'utilisateur.
import path from 'node:path';

type Listener<T> = (value: T) => unknown;

export class EventEmitter<T> {
    private readonly listeners = new Set<Listener<T>>();
    disposed = false;

    readonly event = (listener: Listener<T>): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => void this.listeners.delete(listener) };
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

/** Panneau webview : messages postés vers la page, écouteurs attachés, fermeture. */
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
        // rien à faire
    }

    dispose(): void {
        if (!this.disposed) {
            this.disposed = true;
            this.disposal.fire();
        }
    }

    /** Message envoyé par la page. */
    receive(message: unknown): void {
        this.messages.fire(message);
    }

    /** Écouteurs encore attachés au panneau (messages et fermeture). */
    get listenerCount(): number {
        return this.messages.listenerCount + this.disposal.listenerCount;
    }
}

/** Ce que l'extension a fait côté VS Code. */
export const recorded = {
    panels: [] as FakeWebviewPanel[],
    warnings: [] as string[],
    errors: [] as string[],
    infos: [] as string[],
    opened: [] as string[],
};

export const workspace = {
    workspaceFolders: [] as { uri: Uri }[],
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

export function resetFakeVscode(): void {
    for (const list of Object.values(recorded)) {
        list.length = 0;
    }
    workspace.workspaceFolders = [];
}
