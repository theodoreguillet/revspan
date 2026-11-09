// Contrat de l'API locale, partagé par le serveur (src/server) et la page (src/web).
// Toutes les routes sont sous /api ; toute requête autre que GET porte l'en-tête X-Strata: 1.

export const MUTATION_HEADER = 'X-Strata';

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

export interface ApiErrorBody {
    error: { code: ErrorCode; message: string };
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

// ---------- Réglages ----------

/** vscode : stockage sécurisé de VS Code (extension). */
export type TokenStoreKind = 'keychain' | 'secret-tool' | 'file' | 'vscode';

export interface Settings {
    email: string;
    hasToken: boolean;
    tokenStore: TokenStoreKind;
    repos: string[];
    me: User | null;
}

/** token : chaîne non vide pour le remplacer, "" pour le supprimer. */
export interface SettingsUpdate {
    email?: string;
    token?: string;
    repos?: string[];
}

export type ConnectionTest = { ok: true; me: User } | { ok: false; error: ApiErrorBody['error'] };

// ---------- Accueil ----------

export type HomeGroupKey = 'to-review' | 'rebase-only' | 'up-to-date' | 'mine' | 'others';

export interface PrCard extends PrRef {
    title: string;
    author: User | null;
    url: string;
    createdOn: string;
    updatedOn: string;
    /** null : PR qui ne me concerne pas (historique non chargé). */
    versionsCount: number | null;
    lastPushAt: string;
    lastReviewed: number | null;
    newVersions: number;
    /** null : types des nouvelles versions pas encore calculés. */
    newCodeVersions: number | null;
    approvals: number;
    myApproval: boolean;
    newComments: number;
}

export interface HomeGroup {
    key: HomeGroupKey;
    title: string;
    prs: PrCard[];
}

export interface Home {
    me: User | null;
    /** Dépôts suivis (réglages) ; vide tant que l'utilisateur n'en a pas choisi. */
    repos: string[];
    groups: HomeGroup[];
    errors: { repo: string; message: string }[];
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
    /** 1..n, ordre chronologique. */
    index: number;
    hash: string;
    shortHash: string;
    pushedAt: string;
    pushedBy: User | null;
    /** master au moment du push. */
    destHash: string;
    /** merge-base réelle (vide si la version est indisponible). */
    base: string;
    baseShort: string;
    isRebase: boolean;
    message: string;
    messageChanged: boolean;
    /**
     * false : Bitbucket a effacé le commit (ancienne version écrasée par un force-push) ; contenu illisible,
     * la version reste dans la frise mais ne peut pas être comparée.
     */
    available: boolean;
}

export type ReviewState = 'approved' | 'changes_requested';

export interface Participant {
    user: User | null;
    role: 'REVIEWER' | 'PARTICIPANT';
    approved: boolean;
    state: ReviewState | null;
    /** Version en cours lors de l'approbation / la demande de modifs. */
    approvedVersion: number | null;
}

export type ReviewSource = 'approval' | 'comment' | 'local';

export interface Review {
    lastReviewed: number | null;
    lastReviewedSource: ReviewSource | null;
    lastReviewedAt: string | null;
    /** chemin → empreinte du contenu vu. */
    viewed: Record<string, string>;
}

export interface Reaction {
    emoji: string;
    users: User[];
    /** Mes réponses-emoji (vide si je n'ai pas réagi). */
    myCommentIds: number[];
}

export interface Comment {
    id: number;
    user: User | null;
    createdOn: string;
    /** Version en cours à la création (null juste après une création via l'API). */
    version: number | null;
    /** HTML rendu par Bitbucket : non fiable, à assainir côté page. */
    html: string;
    raw: string;
    isNew: boolean;
    deleted: boolean;
    mine: boolean;
    reactions: Reaction[];
}

export interface Thread {
    /** id du commentaire racine. */
    id: number;
    /** null = commentaire général. */
    path: string | null;
    anchor: { to: number | null; from: number | null } | null;
    version: number;
    resolved: boolean;
    resolvedBy: User | null;
    /** Racine d'abord, puis réponses (ordre chronologique), sans les réactions. */
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
    /** Version de référence quand ce n'est pas la précédente (versions intermédiaires indisponibles) ; 0 = base. */
    since?: number;
    /** Lignes de l'auteur, après retrait du bruit master. */
    added: number;
    removed: number;
    files: { path: string; added: number; removed: number; category: FileCategory }[];
    /** Fichiers masqués car venus de master. */
    masterFiles: number;
    /** Fichiers avec une zone touchée par master et par l'auteur. */
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
    /** Plages [début, fin[ (indices de caractères) à surligner. */
    hl: [number, number][];
    /** Dernière ligne sans retour à la ligne final. */
    noEol?: true;
}

export interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    /** Section englobante façon git (ex. « export default class CreateRecord … »). */
    header: string;
    lines: DiffLine[];
}

export interface ThreadPlacement {
    threadId: number;
    /** Ligne côté « to » où afficher le fil ; null = niveau fichier. */
    line: number | null;
    /** La ligne d'origine a changé depuis le commentaire. */
    moved: boolean;
    /** La ligne existe mais hors des hunks affichés. */
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
    /** Empreinte du contenu côté « to » (pour « vu »). */
    contentHash: string;
    /** Zone modifiée par master et par l'auteur (rebase). */
    conflict: boolean;
    hunks: Hunk[];
    threads: ThreadPlacement[];
}

export interface Comparison {
    from: number;
    to: number;
    stats: { files: number; added: number; removed: number };
    /** Triés : code d'abord puis deps, puis par chemin. */
    files: FileDiff[];
    /** Chemins masqués (venus de master). */
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

export interface ReactRequest {
    commentId: number;
    emoji: string;
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
    app: 'strata';
    version: string;
}
