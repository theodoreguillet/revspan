// Messages received from the page: nothing is used before being checked (shape, types, PR reference),
// and "Open file" never leaves the repository's local copy.
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

/** Message from the page, or null if malformed (to be ignored). The method and the API path are checked by the bridge. */
export function parseWebviewMessage(data: unknown): WebviewToHost | null {
    const result = messageSchema.safeParse(data);
    return result.success ? result.data : null;
}

/** Absolute path of a PR file in the local copy, or null if it is absolute or leaves the repository ("../"). */
export function fileInRepo(repoDir: string, file: string): string | null {
    if (path.isAbsolute(file) || file.includes('\0')) {
        return null;
    }
    const root = path.resolve(repoDir);
    const resolved = path.resolve(root, file);
    return resolved.startsWith(root + path.sep) ? resolved : null;
}
