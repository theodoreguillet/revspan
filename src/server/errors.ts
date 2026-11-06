import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorCode } from '../shared/api.ts';

/** Erreur métier traduite en réponse HTTP { error: { code, message } }. */
export class AppError extends Error {
    readonly status: ContentfulStatusCode;
    readonly code: ErrorCode;

    constructor(status: ContentfulStatusCode, code: ErrorCode, message: string) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
    }
}

export const badRequest = (message: string): AppError => new AppError(400, 'BAD_REQUEST', message);
