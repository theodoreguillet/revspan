// Adresses des documents virtuels de l'éditeur de diff : le chemin se termine par celui du fichier
// (VS Code choisit ainsi la coloration syntaxique), les paramètres de la comparaison sont dans la requête.
import type { PrRef } from '../../shared/api.ts';

export const DIFF_SCHEME = 'strata';

export type DiffSide = 'old' | 'new';

export interface DiffDocument {
    ref: PrRef;
    from: number;
    to: number;
    side: DiffSide;
    path: string;
    oldPath: string | null;
}

/** Parties d'URI (chemin + requête) d'un côté de la comparaison. */
export function encodeDiffDocument(doc: DiffDocument): { path: string; query: string } {
    const shown = doc.side === 'old' ? doc.oldPath ?? doc.path : doc.path;
    const query = new URLSearchParams({
        ws: doc.ref.workspace,
        repo: doc.ref.repo,
        id: String(doc.ref.id),
        from: String(doc.from),
        to: String(doc.to),
        side: doc.side,
        path: doc.path,
        ...(doc.oldPath ? { oldPath: doc.oldPath } : {}),
    });
    return { path: `/${doc.ref.repo}/${doc.side === 'old' ? `v${doc.from}` : `v${doc.to}`}/${shown}`, query: query.toString() };
}

export function decodeDiffDocument(query: string): DiffDocument | null {
    const params = new URLSearchParams(query);
    const [ws, repo, path, side] = [params.get('ws'), params.get('repo'), params.get('path'), params.get('side')];
    const id = Number(params.get('id'));
    const from = Number(params.get('from'));
    const to = Number(params.get('to'));
    if (!ws || !repo || !path || (side !== 'old' && side !== 'new') || !Number.isInteger(id) || !Number.isInteger(from) || !Number.isInteger(to)) {
        return null;
    }
    return { ref: { workspace: ws, repo, id }, from, to, side, path, oldPath: params.get('oldPath') };
}

/** Titre de l'onglet de diff, ex. « CreateRecord.ts (v9 → v10) ». */
export function diffTitle(path: string, from: number, to: number): string {
    const name = path.split('/').pop() ?? path;
    return `${name} (${from === 0 ? 'base' : `v${from}`} → v${to})`;
}
