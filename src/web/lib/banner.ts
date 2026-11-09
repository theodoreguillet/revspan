// Resume banner: what changed since my last review.
import type { PrDetail, Version, VersionSummary } from '../../shared/api.ts';
import { approvalHolds } from './approvals.ts';
import type { Translator } from '../i18n/index.ts';
import { fmtDay, masterMasked, MINUS } from './format.ts';
import { CODE_KINDS, type SummaryMap, TRIVIAL_KINDS } from './kinds.ts';
import { filesSegs } from './describe.ts';
import { b, tSegs, type Seg } from './segments.ts';
import { newActivity } from './threads.ts';

export type BannerVariant = 'up-to-date' | 'first' | 'loading' | 'fast' | 'since';

export interface BannerModel {
    variant: BannerVariant;
    head: string;
    lines: Seg[][];
    /** mark: "Mark vN as reviewed"; reapprove: "Re-approve vN"; none: no button. */
    action: 'mark' | 'reapprove' | 'none';
    /** Show the rule "Approving or commenting marks the version as reviewed...". */
    rule: boolean;
    latest: number;
}

function commentsLine(tr: Translator, data: PrDetail): Seg[] | null {
    const { newThreads, replies, names } = newActivity(data.threads);
    if (!newThreads && !replies) {
        return null;
    }
    const threads = [b(tr.t('banner.newThreads', { count: newThreads }))];
    const answers = [b(tr.t('banner.newReplies', { count: replies }))];
    const who = tr.list(names);
    if (newThreads && replies) {
        return tSegs(tr, 'banner.activityBoth', { threads, replies: answers, names: who });
    }
    return tSegs(tr, 'banner.activity', { items: newThreads ? threads : answers, names: who });
}

/**
 * One line per version: "v10: CreateRecord.ts and coverage.config.json, +2 -2". Version absent from the summary (pushed
 * while reading, summary being reloaded): "v11: ...", as in the timeline.
 */
export function versionLine(tr: Translator, v: Version, sum: VersionSummary | undefined): Seg[] {
    const masked = sum?.masterFiles ? ` (${masterMasked(tr, sum.masterFiles)})` : '';
    const rebase = v.isRebase ? ` · ${tr.t('banner.rebasedOnMaster')}${masked}` : '';
    const line = (details: Seg[], suffix = rebase): Seg[] => [...tSegs(tr, 'banner.versionLine', { version: [b(`v${v.index}`)], details }), ...(suffix ? [suffix] : [])];
    if (!sum) {
        return line(['…']);
    }
    switch (sum.kind) {
        case 'code':
        case 'creation':
            return line([...filesSegs(tr, sum.files), `, +${sum.added} ${MINUS}${sum.removed}`]);
        case 'deps':
            return line(tSegs(tr, 'banner.depsOnly', { files: filesSegs(tr, sum.files) }));
        case 'rebase-only':
            return line([`${tr.t('banner.rebaseOnlyLine')}${masked}`], '');
        case 'message-only':
            return line([tr.t('common.commitMessageOnly')]);
        default:
            return line([tr.t('banner.nothingFromAuthor')]);
    }
}

export function bannerModel(tr: Translator, data: PrDetail, sums: SummaryMap, summaryLoaded: boolean): BannerModel {
    const n = data.versions.length;
    const lr = data.review.lastReviewed;
    const at = data.review.lastReviewedAt;
    const when = at ? ` (${fmtDay(tr, at)})` : '';
    const comments = commentsLine(tr, data);
    const base = { latest: n };
    const versions = (count: number): string => tr.t('common.versions', { count });

    if (lr != null && lr >= n) {
        return { ...base, variant: 'up-to-date', head: `${tr.t('banner.upToDate', { version: n })}${when}`, lines: comments ? [comments] : [], action: 'none', rule: false };
    }

    if (lr == null) {
        const lines: Seg[][] = [];
        if (summaryLoaded) {
            const code = data.versions.filter((v) => CODE_KINDS.has(sums.get(v.index)?.kind ?? 'none')).length;
            const rebases = data.versions.filter((v) => v.isRebase).length;
            lines.push([tr.t('banner.firstSummary', { code: versions(code), rebases: tr.t('common.rebases', { count: rebases }) })]);
        }
        if (comments) {
            lines.push(comments);
        }
        const first = data.versions[0];
        const head = first
            ? tr.t('banner.firstSince', { versions: versions(n), date: fmtDay(tr, first.pushedAt) })
            : tr.t('banner.first', { versions: versions(n) });
        return { ...base, variant: 'first', head, lines, action: 'mark', rule: true };
    }

    const after = data.versions.slice(lr);
    const since = `${tr.t('banner.since', { version: lr })}${when}`;
    const sinceHead = tr.t('banner.sinceHead', { since, versions: versions(after.length) });
    if (!summaryLoaded) {
        const lines: Seg[][] = [[tr.t('banner.analyzing')]];
        if (comments) {
            lines.push(comments);
        }
        return { ...base, variant: 'loading', head: sinceHead, lines, action: 'mark', rule: true };
    }

    const sumOf = (v: Version): VersionSummary | undefined => sums.get(v.index);
    const msgChanged = after.some((v) => v.messageChanged);
    if (after.every((v) => { const s = sumOf(v); return !!s && TRIVIAL_KINDS.has(s.kind); })) {
        const masterFiles = after.reduce((s, v) => s + (sumOf(v)?.masterFiles ?? 0), 0);
        const me = data.me ? data.participants.find((p) => p.user?.uuid === data.me?.uuid) : undefined;
        const mine = !!data.me && data.pr.author?.uuid === data.me.uuid;
        const holds = approvalHolds(me, sums, n, true);
        const summary = [tr.t('banner.nothingToReview')];
        if (masterFiles) {
            summary.push(masterMasked(tr, masterFiles));
        }
        if (!comments) {
            summary.push(tr.t('banner.noNewComments'));
        }
        const lines: Seg[][] = [[summary.join(' · ')]];
        if (holds && !mine) {
            lines.push([me?.approvedVersion ? tr.t('banner.approvalHoldsVersion', { version: me.approvedVersion }) : tr.t('banner.approvalHolds')]);
        }
        if (comments) {
            lines.push(comments);
        }
        if (msgChanged) {
            lines.push([tr.t('common.commitMessageChanged')]);
        }
        const canReapprove = !mine && !holds && data.pr.state === 'OPEN';
        return {
            ...base,
            variant: 'fast',
            head: tr.t('banner.fastHead', { version: lr }),
            lines,
            action: canReapprove ? 'reapprove' : 'mark',
            rule: false,
        };
    }

    // Version absent from the summary (pushed while reading): listed alone, without detail, and nothing is claimed about its code.
    const isCodeV = (v: Version): boolean => CODE_KINDS.has(sumOf(v)?.kind ?? 'none');
    const isUnknown = (v: Version): boolean => !sumOf(v);
    const code = after.filter(isCodeV);
    const other = after.filter((v) => !isCodeV(v) && !isUnknown(v));
    const unknown = after.some(isUnknown);
    let head = sinceHead;
    if (after.length === 1 && !unknown) {
        head += code.length ? tr.t('banner.oneWithCode') : tr.t('banner.oneWithoutCode');
    } else if (code.length) {
        head += tr.t('banner.someWithCode', { count: code.length });
    } else if (!unknown) {
        head += tr.t('banner.noneWithCode');
    }
    const lines: Seg[][] = [];
    for (const v of after.filter((x) => isCodeV(x) || isUnknown(x)).reverse()) {
        lines.push(versionLine(tr, v, sumOf(v)));
    }
    if (other.length > 4) {
        const reb = other.filter((v) => sumOf(v)?.kind === 'rebase-only');
        const deps = other.filter((v) => sumOf(v)?.kind === 'deps');
        const masterFiles = other.reduce((s, v) => s + (sumOf(v)?.masterFiles ?? 0), 0);
        const parts: string[] = [];
        if (reb.length) {
            parts.push(`${tr.t('banner.rebaseOnlyVersions', { count: reb.length })}${masterFiles ? ` (${masterMasked(tr, masterFiles)})` : ''}`);
        }
        if (deps.length) {
            parts.push(tr.t('banner.depsVersions', { count: deps.length }));
        }
        const rest = other.length - reb.length - deps.length;
        if (rest) {
            parts.push(tr.t('banner.otherVersions', { count: rest }));
        }
        lines.push([tr.t('banner.noCodeSummary', { versions: versions(other.length), details: parts.join(', ') })]);
    } else if (other.length) {
        const segs: Seg[] = [];
        [...other].reverse().forEach((v, k) => {
            if (k) {
                segs.push(' · ');
            }
            segs.push(...versionLine(tr, v, sumOf(v)));
        });
        lines.push(segs);
    }
    if (comments) {
        lines.push(comments);
    }
    if (msgChanged) {
        lines.push([tr.t('common.commitMessageChanged')]);
    }
    return { ...base, variant: 'since', head, lines, action: 'mark', rule: true };
}
