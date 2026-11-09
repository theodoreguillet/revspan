import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorCode, ErrorParams, ErrorPayload } from '../shared/api.ts';

/** Business error turned into the HTTP response { error: { code, message, params } }. */
export class AppError extends Error {
    readonly status: ContentfulStatusCode;
    readonly code: ErrorCode;
    /** Values the page needs to show a translated message (the message itself is English). */
    readonly params: ErrorParams | undefined;

    constructor(status: ContentfulStatusCode, code: ErrorCode, message: string, params?: ErrorParams) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        this.params = params;
    }

    /** Body of the error, as sent to the page. */
    toPayload(): ErrorPayload {
        return this.params ? { code: this.code, message: this.message, params: this.params } : { code: this.code, message: this.message };
    }
}

export const badRequest = (message: string, params?: ErrorParams): AppError => new AppError(400, 'BAD_REQUEST', message, params);

/** Payload of any error: an AppError as is, anything else as INTERNAL with its message as detail. */
export function errorPayload(error: unknown): ErrorPayload {
    if (error instanceof AppError) {
        return error.toPayload();
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { code: 'INTERNAL', message: `Internal error: ${detail}`, params: { detail } };
}
