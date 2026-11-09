// Adresses des documents virtuels de l'éditeur de diff : le chemin se termine par celui du fichier
// (VS Code choisit ainsi la coloration syntaxique), les paramètres de la comparaison sont dans la requête.
import type { PrRef } from '../../shared/api.ts';
import { prRefSchema } from '../../server/http/schemas.ts';

export const DIFF_SCHEME = 'revspan';

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

/** Entier ≥ min écrit en chiffres, sinon null : un paramètre absent ne vaut pas 0 (Number(null) === 0). */
function integerParam(value: string | null, min: number): number | null {
    const n = value !== null && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(n) && n >= min ? n : null;
}

export function decodeDiffDocument(query: string): DiffDocument | null {
    const params = new URLSearchParams(query);
    const [path, side] = [params.get('path'), params.get('side')];
    const id = integerParam(params.get('id'), 1);
    const from = integerParam(params.get('from'), 0);
    const to = integerParam(params.get('to'), 1);
    const ref = prRefSchema.safeParse({ workspace: params.get('ws'), repo: params.get('repo'), id });
    if (!ref.success || id === null || from === null || to === null || !path || (side !== 'old' && side !== 'new')) {
        return null;
    }
    return { ref: ref.data, from, to, side, path, oldPath: params.get('oldPath') };
}

/** Titre de l'onglet de diff, ex. « CreateRecord.ts (v9 → v10) ». */
export function diffTitle(path: string, from: number, to: number): string {
    const name = path.split('/').pop() ?? path;
    return `${name} (${from === 0 ? 'base' : `v${from}`} → v${to})`;
}
