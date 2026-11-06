// Objets bruts de l'API Bitbucket Cloud 2.0 (seuls les champs utilisés sont typés).

export interface BbUser {
    uuid?: string;
    display_name?: string;
    nickname?: string;
}

export interface BbCommitRef {
    hash: string;
}

export interface BbParticipant {
    user?: BbUser;
    role?: 'REVIEWER' | 'PARTICIPANT';
    approved?: boolean;
    state?: 'approved' | 'changes_requested' | null;
}

export interface BbPullRequest {
    id: number;
    title?: string;
    description?: string;
    state?: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
    author?: BbUser;
    source?: { branch?: { name?: string }; commit?: BbCommitRef };
    destination?: { branch?: { name?: string }; commit?: BbCommitRef };
    created_on?: string;
    updated_on?: string;
    participants?: BbParticipant[];
    reviewers?: BbUser[];
    links?: { html?: { href?: string } };
}

export interface BbComment {
    id: number;
    created_on: string;
    updated_on?: string;
    user?: BbUser;
    content?: { raw?: string; html?: string };
    deleted?: boolean;
    parent?: { id: number };
    inline?: { path: string; to?: number | null; from?: number | null };
    resolution?: { user?: BbUser } | null;
}

export interface BbActivity {
    update?: {
        date: string;
        author?: BbUser;
        source?: { commit?: BbCommitRef };
        destination?: { commit?: BbCommitRef };
    };
    approval?: { date: string; user?: BbUser };
    changes_requested?: { date: string; user?: BbUser };
    comment?: BbComment;
}

export interface BbCommit {
    hash: string;
    message?: string;
    date?: string;
    parents?: BbCommitRef[];
}

export interface BbDiffstatEntry {
    status: string;
    old?: { path: string } | null;
    new?: { path: string } | null;
    lines_added?: number;
    lines_removed?: number;
}

export interface BbPage<T> {
    values?: T[];
    next?: string;
}

export interface BbSrcMeta {
    attributes?: string[];
}
