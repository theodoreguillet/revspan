// "VS Code diff": the comparison of a file in the native diff editor (syntax highlighting),
// with exactly the two sides of the page (version A replayed onto B's base if needed).
import * as vscode from 'vscode';
import type { PrRef } from '../shared/api.ts';
import type { PrService } from '../server/services/pr-service.ts';
import { DIFF_SCHEME, decodeDiffDocument, diffTitle, encodeDiffDocument, type DiffDocument } from './lib/diff-uri.ts';

const MAX_CACHED = 50;

export class DiffDocuments implements vscode.TextDocumentContentProvider {
    private readonly prs: PrService;
    private readonly sides = new Map<string, Promise<{ oldText: string; newText: string }>>();

    constructor(prs: PrService) {
        this.prs = prs;
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const doc = decodeDiffDocument(uri.query);
        if (!doc) {
            return '';
        }
        const sides = await this.load(doc);
        return doc.side === 'old' ? sides.oldText : sides.newText;
    }

    async open(ref: PrRef, from: number, to: number, path: string, oldPath: string | null): Promise<void> {
        const uriOf = (side: DiffDocument['side']): vscode.Uri => vscode.Uri.from({ scheme: DIFF_SCHEME, ...encodeDiffDocument({ ref, from, to, side, path, oldPath }) });
        await vscode.commands.executeCommand('vscode.diff', uriOf('old'), uriOf('new'), diffTitle(path, from, to), { preview: true });
    }

    /** Both sides are computed only once for the two documents of the editor. */
    private load(doc: DiffDocument): Promise<{ oldText: string; newText: string }> {
        const key = JSON.stringify([doc.ref, doc.from, doc.to, doc.path, doc.oldPath]);
        let sides = this.sides.get(key);
        if (!sides) {
            sides = this.prs.fileSides(doc.ref, doc.from, doc.to, { path: doc.path, oldPath: doc.oldPath });
            sides.catch(() => this.sides.delete(key));
            this.sides.set(key, sides);
            if (this.sides.size > MAX_CACHED) {
                const oldest = this.sides.keys().next();
                if (!oldest.done) {
                    this.sides.delete(oldest.value);
                }
            }
        }
        return sides;
    }
}
