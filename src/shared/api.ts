// Local API contract, shared by the server (src/server) and the page (src/web).
// All routes are under /api; any request other than GET carries the X-Revspan: 1 header.

export const MUTATION_HEADER = 'X-Revspan';

export type ErrorCode =
    | 'NO_TOKEN'
    | 'BB_UNAUTHORIZED'
    | 'BB_FORBIDDEN'
    | 'BB_NOT_FOUND'
    | 'BB_UNREACHABLE'
    | 'BB_ERROR'
    | 'BAD_REQUEST'
    | 'VERSION_UNAVAILABLE'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'INTERNAL';

/** Finer cause within an error code, so the page can show a specific translated message. */
export type ErrorReason = 'invalid-email' | 'email-required' | 'profile-unreadable' | 'no-versions';

/** Machine-readable details of an error: the page translates the message from the code and these values. */
export interface ErrorParams {
    reason?: ErrorReason;
    /** Bitbucket API path concerned (BB_NOT_FOUND, BB_ERROR). */
    path?: string;
    /** HTTP status returned by Bitbucket (BB_ERROR). */
    status?: number;
    /** Text from Bitbucket or from the system, shown as is (BB_FORBIDDEN, BB_ERROR, BB_UNREACHABLE, INTERNAL). */
    detail?: string;
    /** Version concerned (VERSION_UNAVAILABLE). */
    version?: number;
}

/** An error: stable code, English message (also read in the terminal), optional parameters for translation. */
export interface ErrorPayload {
    code: ErrorCode;
    message: string;
    params?: ErrorParams;
}

export interface ApiErrorBody {
    error: ErrorPayload;
}

export interface User {
    uuid: string;
    displayName: string;
    nickname?: string;
}

export interface PrRef {
    workspace: string;
    repo: string;
    id: number;
}

// ---------- Settings ----------

/** vscode: VS Code's secure storage (extension). */
export type TokenStoreKind = 'keychain' | 'secret-tool' | 'file' | 'vscode';

export interface Settings {
    email: string;
    hasToken: boolean;
    tokenStore: TokenStoreKind;
    repos: string[];
    me: User | null;
}

/** token: non-empty string to replace it, "" to delete it. */
export interface SettingsUpdate {
    email?: string;
    token?: string;
    repos?: string[];
}

export type ConnectionTest = { ok: true; me: User } | { ok: false; error: ApiErrorBody['error'] };

// ---------- Home ----------

export type HomeGroupKey = 'to-review' | 'rebase-only' | 'up-to-date' | 'mine' | 'others';

export interface PrCard extends PrRef {
    title: string;
    author: User | null;
    url: string;
    createdOn: string;
    updatedOn: string;
    /** null: PR that does not concern me (history not loaded). */
    versionsCount: number | null;
    lastPushAt: string;
    lastReviewed: number | null;
    newVersions: number;
    /** null: types of the new versions not yet computed. */
    newCodeVersions: number | null;
    approvals: number;
    myApproval: boolean;
    newComments: number;
}

/** A home group: the page and the VS Code tree each show their own translation of the key. */
export interface HomeGroup {
    key: HomeGroupKey;
    prs: PrCard[];
}

export interface Home {
    me: User | null;
    /** Tracked repositories (settings); empty until the user has chosen some. */
    repos: string[];
    groups: HomeGroup[];
    /** Repositories that could not be read, with the error (same shape as an API error). */
    errors: ({ repo: string } & ErrorPayload)[];
}

// ---------- PR ----------

export type PrState = 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';

export interface PrInfo extends PrRef {
    title: string;
    description: string;
    state: PrState;
    author: User | null;
    sourceBranch: string;
    destBranch: string;
    createdOn: string;
    updatedOn: string;
    url: string;
}

export interface Version {
    /** 1..n, chronological order. */
    index: number;
    hash: string;
    shortHash: string;
    pushedAt: string;
    pushedBy: User | null;
    /** master at push time. */
    destHash: string;
    /** Real merge-base (empty if the version is unavailable). */
    base: string;
    baseShort: string;
    isRebase: boolean;
    message: string;
    messageChanged: boolean;
    /**
     * false: Bitbucket erased the commit (old version overwritten by a force-push); content unreadable,
     * the version stays in the timeline but cannot be compared.
     */
    available: boolean;
}

export type ReviewState = 'approved' | 'changes_requested';

export interface Participant {
    user: User | null;
    role: 'REVIEWER' | 'PARTICIPANT';
    approved: boolean;
    state: ReviewState | null;
    /** Version in progress at the time of the approval / change request. */
    approvedVersion: number | null;
}

export type ReviewSource = 'approval' | 'comment' | 'local';

export interface Review {
    lastReviewed: number | null;
    lastReviewedSource: ReviewSource | null;
    lastReviewedAt: string | null;
    /** path -> fingerprint of the content seen. */
    viewed: Record<string, string>;
}

export interface Comment {
    id: number;
    user: User | null;
    createdOn: string;
    /** Version in progress at creation (null right after a creation through the API). */
    version: number | null;
    /** HTML rendered by Bitbucket: untrusted, to be sanitized on the page side. */
    html: string;
    raw: string;
    isNew: boolean;
    deleted: boolean;
    mine: boolean;
}

export interface Thread {
    /** id of the root comment. */
    id: number;
    /** null = general comment. */
    path: string | null;
    anchor: { to: number | null; from: number | null } | null;
    version: number;
    resolved: boolean;
    resolvedBy: User | null;
    /** Root first, then replies (chronological order). */
    comments: Comment[];
}

export interface PrDetail {
    pr: PrInfo;
    me: User | null;
    versions: Version[];
    participants: Participant[];
    review: Review;
    threads: Thread[];
}

export type VersionKind = 'creation' | 'code' | 'deps' | 'rebase-only' | 'message-only' | 'none' | 'unavailable';
export type FileCategory = 'code' | 'deps';

export interface VersionSummary {
    index: number;
    kind: VersionKind;
    /** Reference version when it is not the previous one (intermediate versions unavailable); 0 = base. */
    since?: number;
    /** Author's lines, after removing master noise. */
    added: number;
    removed: number;
    files: { path: string; added: number; removed: number; category: FileCategory }[];
    /** Files hidden because they came from master. */
    masterFiles: number;
    /** Files with an area touched by both master and the author. */
    conflicts: number;
}

export interface Summary {
    versions: VersionSummary[];
}

export interface DiffLine {
    t: ' ' | '+' | '-';
    o: number | null;
    n: number | null;
    text: string;
    /** Ranges [start, end[ (character indices) to highlight. */
    hl: [number, number][];
    /** Last line without a final newline. */
    noEol?: true;
}

export interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    /** Enclosing section, git-style (e.g. "export default class CreateRecord ..."). */
    header: string;
    lines: DiffLine[];
}

export interface ThreadPlacement {
    threadId: number;
    /** Line on the "to" side where to show the thread; null = file level. */
    line: number | null;
    /** The original line changed since the comment. */
    moved: boolean;
    /** The line exists but outside the displayed hunks. */
    outOfHunks: boolean;
}

export type FileStatus = 'added' | 'removed' | 'modified' | 'renamed';

export interface FileDiff {
    path: string;
    oldPath: string | null;
    status: FileStatus;
    category: FileCategory;
    binary: boolean;
    tooLarge: boolean;
    added: number;
    removed: number;
    /** Fingerprint of the content on the "to" side (for "seen"). */
    contentHash: string;
    /** Area modified by both master and the author (rebase). */
    conflict: boolean;
    hunks: Hunk[];
    threads: ThreadPlacement[];
}

export interface Comparison {
    from: number;
    to: number;
    stats: { files: number; added: number; removed: number };
    /** Sorted: code first then deps, then by path. */
    files: FileDiff[];
    /** Hidden paths (coming from master). */
    masterOnly: string[];
    messageChanged: boolean;
    messageFrom: string;
    messageTo: string;
}

// ---------- Actions ----------

export interface NewComment {
    raw: string;
    parentId?: number;
    inline?: { path: string; to: number };
}

export interface ViewedRequest {
    path: string;
    contentHash?: string;
    viewed: boolean;
}

export interface Ok {
    ok: true;
}

export interface Health {
    app: 'revspan';
    version: string;
}
