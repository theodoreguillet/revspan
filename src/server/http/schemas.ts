// Validation of HTTP inputs (zod). The produced types match the src/shared/api.ts contract.
import { z } from 'zod';
import type { EditComment, NewComment, PrRef, SettingsUpdate, ViewedRequest } from '../../shared/api.ts';
import { badRequest } from '../errors.ts';

const NAME = /^[A-Za-z0-9._-]+$/;
const notDotSegment = (s: string): boolean => s !== '.' && s !== '..';

export const prRefSchema: z.ZodType<PrRef> = z.object({
    workspace: z.string().regex(NAME).refine(notDotSegment, 'Invalid workspace.'),
    repo: z.string().regex(NAME).refine(notDotSegment, 'Invalid repository.'),
    id: z.coerce.number().int().positive(),
});

export const compareQuerySchema = z.object({
    from: z.coerce.number().int().min(0),
    to: z.coerce.number().int().min(1),
    context: z.coerce.number().int().min(0).max(1_000_000).default(3),
});

export const settingsUpdateSchema: z.ZodType<SettingsUpdate> = z.object({
    email: z.string().max(320).optional(),
    token: z.string().max(4096).optional(),
    repos: z.array(z.string().max(300)).max(200).optional(),
    // Values are checked by normalizeReviewSettings (an invalid value gets its default, not a 400).
    review: z.object({
        requiredApprovals: z.any(),
        requiredApprovalsByRepo: z.any(),
        followed: z.any(),
        hideUnfollowed: z.any(),
        notifications: z.record(z.string(), z.any()).optional(),
        refreshMinutes: z.any(),
    }).partial().optional(),
});

const commentRawSchema = z.string().trim().min(1, 'The comment is empty.').max(32000);

export const newCommentSchema: z.ZodType<NewComment> = z.object({
    raw: commentRawSchema,
    parentId: z.number().int().positive().optional(),
    inline: z.object({ path: z.string().min(1).max(4096), to: z.number().int().positive() }).optional(),
});

export const editCommentSchema: z.ZodType<EditComment> = z.object({
    raw: commentRawSchema,
});

const viewedFileSchema = z.object({
    path: z.string().min(1).max(4096),
    contentHash: z.string().max(128).optional(),
});

const viewedOneSchema = viewedFileSchema.extend({ viewed: z.boolean() });
const viewedManySchema = z.object({ files: z.array(viewedFileSchema).min(1).max(2000), viewed: z.boolean() });

/** Branches on the shape so that a bad payload reports its own issue (a plain union only says "Invalid input"). */
export const viewedSchema: z.ZodType<ViewedRequest> = z.any().transform((value, ctx) => {
    const schema = typeof value === 'object' && value !== null && 'files' in value ? viewedManySchema : viewedOneSchema;
    const result = schema.safeParse(value);
    if (!result.success) {
        for (const issue of result.error.issues) {
            ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
        }
        return z.NEVER;
    }
    return result.data;
},
) as unknown as z.ZodType<ViewedRequest>;

export const reviewedSchema = z.object({ version: z.number().int().positive() });

export const commentIdSchema = z.coerce.number().int().positive();

/** Validates an input; readable message on failure (400). */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) {
        const issue = result.error.issues[0];
        const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
        throw badRequest(`${issue?.message ?? 'Invalid request.'}${where}`);
    }
    return result.data;
}
