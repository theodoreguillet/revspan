// Raw objects of the Bitbucket Cloud 2.0 API (only the fields in use are typed).

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
    /** Comments on the PR (part of the list's default fields). */
    comment_count?: number;
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

export interface BbStatus {
    key: string;
    name?: string;
    state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED';
    url?: string;
    updated_on?: string;
    commit?: { hash: string };
}

export interface BbBranch {
    name?: string;
    target?: { hash?: string };
}
