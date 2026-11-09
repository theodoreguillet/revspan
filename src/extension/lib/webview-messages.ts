// Messages reçus de la page : rien n'est utilisé avant d'avoir été vérifié (forme, types, référence de PR),
// et « Ouvrir le fichier » ne sort jamais de la copie locale du dépôt.
import path from 'node:path';
import { z } from 'zod';
import type { WebviewToHost } from '../../shared/webview-protocol.ts';
import { prRefSchema } from '../../server/http/schemas.ts';

const filePath = z.string().min(1).max(4096);

const messageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('request'), id: z.number().int(), method: z.string(), path: z.string(), body: z.unknown().optional() }),
    z.object({ type: z.literal('openFile'), ref: prRefSchema, path: filePath, line: z.number().int().positive().nullable() }),
    z.object({
        type: z.literal('openDiff'),
        ref: prRefSchema,
        from: z.number().int().min(0),
        to: z.number().int().positive(),
        path: filePath,
        oldPath: filePath.nullable(),
    }),
]);

/** Message de la page, ou null s'il est mal formé (à ignorer). La méthode et le chemin d'API sont vérifiés par le pont. */
export function parseWebviewMessage(data: unknown): WebviewToHost | null {
    const result = messageSchema.safeParse(data);
    return result.success ? result.data : null;
}

/** Chemin absolu d'un fichier de la PR dans la copie locale, ou null s'il est absolu ou sort du dépôt (« ../ »). */
export function fileInRepo(repoDir: string, file: string): string | null {
    if (path.isAbsolute(file) || file.includes('\0')) {
        return null;
    }
    const root = path.resolve(repoDir);
    const resolved = path.resolve(root, file);
    return resolved.startsWith(root + path.sep) ? resolved : null;
}
