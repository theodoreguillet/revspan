// Bandeau de reprise : ce qui a changé depuis ma dernière relecture.
import type { PrDetail, Version, VersionSummary } from '../../shared/api.ts';
import { approvalHolds } from './approvals.ts';
import { fmtDay, frList, masterMasked, MINUS, plural } from './format.ts';
import { CODE_KINDS, type SummaryMap, TRIVIAL_KINDS } from './kinds.ts';
import { filesSegs } from './describe.ts';
import { b, type Seg } from './segments.ts';
import { newActivity } from './threads.ts';

export type BannerVariant = 'up-to-date' | 'first' | 'loading' | 'fast' | 'since';

export interface BannerModel {
    variant: BannerVariant;
    head: string;
    lines: Seg[][];
    /** mark : « Marquer vN comme relue » ; reapprove : « ✓ Réapprouver vN » ; none : aucun bouton. */
    action: 'mark' | 'reapprove' | 'none';
    /** Afficher la règle « Approuver ou commenter marque la version comme relue… ». */
    rule: boolean;
    latest: number;
}

function commentsLine(data: PrDetail): Seg[] | null {
    const { newThreads, replies, names } = newActivity(data.threads);
    if (!newThreads && !replies) {
        return null;
    }
    const parts: Seg[] = ['+ '];
    if (newThreads) {
        parts.push(b(plural(newThreads, 'nouveau fil', 'nouveaux fils')));
    }
    if (replies) {
        if (newThreads) {
            parts.push(' et ');
        }
        parts.push(b(plural(replies, 'nouvelle réponse', 'nouvelles réponses')));
    }
    parts.push(` (${frList(names)})`);
    return parts;
}

/**
 * Une ligne par version : « v10 : CreateRecord.ts et coverage.config.json, +2 −2 ». Version absente du résumé (poussée
 * pendant la lecture, résumé en cours de rechargement) : « v11 : … », comme dans la frise.
 */
export function versionLine(v: Version, sum: VersionSummary | undefined): Seg[] {
    const name = b(`v${v.index}`);
    const rebase = v.isRebase ? ` · rebase sur master${sum?.masterFiles ? ` (${masterMasked(sum.masterFiles)})` : ''}` : '';
    if (!sum) {
        return [name, ' : …', rebase];
    }
    switch (sum.kind) {
        case 'code':
        case 'creation':
            return [name, ' : ', ...filesSegs(sum.files), `, +${sum.added} ${MINUS}${sum.removed}`, rebase];
        case 'deps':
            return [name, ' : ', ...filesSegs(sum.files), ' seulement', rebase];
        case 'rebase-only':
            return [name, ` : rebase sur master, rien de l'auteur${sum.masterFiles ? ` (${masterMasked(sum.masterFiles)})` : ''}`];
        case 'message-only':
            return [name, ' : message du commit seulement', rebase];
        default:
            return [name, ' : rien de l\'auteur', rebase];
    }
}

export function bannerModel(data: PrDetail, sums: SummaryMap, summaryLoaded: boolean): BannerModel {
    const n = data.versions.length;
    const lr = data.review.lastReviewed;
    const at = data.review.lastReviewedAt;
    const comments = commentsLine(data);
    const base = { latest: n };

    if (lr != null && lr >= n) {
        return { ...base, variant: 'up-to-date', head: `Tu es à jour : v${n} relue${at ? ` (${fmtDay(at)})` : ''}`, lines: comments ? [comments] : [], action: 'none', rule: false };
    }

    if (lr == null) {
        const lines: Seg[][] = [];
        if (summaryLoaded) {
            const code = data.versions.filter((v) => CODE_KINDS.has(sums.get(v.index)?.kind ?? 'none')).length;
            const rebases = data.versions.filter((v) => v.isRebase).length;
            lines.push([`${plural(code, 'version')} avec du code, ${plural(rebases, 'rebase')} · « Tout vs master » montre la PR complète`]);
        }
        if (comments) {
            lines.push(comments);
        }
        const first = data.versions[0];
        const head = `Première relecture : ${plural(n, 'version')}${first ? ` depuis le ${fmtDay(first.pushedAt)}` : ''}`;
        return { ...base, variant: 'first', head, lines, action: 'mark', rule: true };
    }

    const after = data.versions.slice(lr);
    const since = `Depuis ta relecture de v${lr}${at ? ` (${fmtDay(at)})` : ''}`;
    if (!summaryLoaded) {
        const lines: Seg[][] = [['Analyse des versions…']];
        if (comments) {
            lines.push(comments);
        }
        return { ...base, variant: 'loading', head: `${since} : ${plural(after.length, 'version')}`, lines, action: 'mark', rule: true };
    }

    const sumOf = (v: Version): VersionSummary | undefined => sums.get(v.index);
    const msgChanged = after.some((v) => v.messageChanged);
    if (after.every((v) => { const s = sumOf(v); return !!s && TRIVIAL_KINDS.has(s.kind); })) {
        const masterFiles = after.reduce((s, v) => s + (sumOf(v)?.masterFiles ?? 0), 0);
        const me = data.me ? data.participants.find((p) => p.user?.uuid === data.me?.uuid) : undefined;
        const mine = !!data.me && data.pr.author?.uuid === data.me.uuid;
        const holds = approvalHolds(me, sums, n, true);
        const lines: Seg[][] = [[`Rien à relire${masterFiles ? ` · ${masterMasked(masterFiles)}` : ''}${comments ? '' : ' · aucun nouveau commentaire'}`]];
        if (holds && !mine) {
            lines.push([`Ton approbation${me?.approvedVersion ? ` de v${me.approvedVersion}` : ''} reste valable sur Bitbucket`]);
        }
        if (comments) {
            lines.push(comments);
        }
        if (msgChanged) {
            lines.push(['message du commit modifié']);
        }
        const canReapprove = !mine && !holds && data.pr.state === 'OPEN';
        return {
            ...base,
            variant: 'fast',
            head: `Depuis ta relecture de v${lr} : seulement des rebases, aucun changement de l'auteur`,
            lines,
            action: canReapprove ? 'reapprove' : 'mark',
            rule: false,
        };
    }

    // Version absente du résumé (poussée pendant la lecture) : listée seule, sans détail, et rien n'est affirmé sur son code.
    const isCodeV = (v: Version): boolean => CODE_KINDS.has(sumOf(v)?.kind ?? 'none');
    const isUnknown = (v: Version): boolean => !sumOf(v);
    const code = after.filter(isCodeV);
    const other = after.filter((v) => !isCodeV(v) && !isUnknown(v));
    const unknown = after.some(isUnknown);
    let head = `${since} : ${plural(after.length, 'version')}`;
    if (after.length === 1 && !unknown) {
        head += code.length ? ', qui touche du code' : ', sans code';
    } else if (code.length) {
        head += code.length === 1 ? ', dont 1 touche du code' : `, dont ${code.length} touchent du code`;
    } else if (!unknown) {
        head += ', aucune ne touche du code';
    }
    const lines: Seg[][] = [];
    for (const v of after.filter((x) => isCodeV(x) || isUnknown(x)).reverse()) {
        lines.push(versionLine(v, sumOf(v)));
    }
    if (other.length > 4) {
        const reb = other.filter((v) => sumOf(v)?.kind === 'rebase-only');
        const deps = other.filter((v) => sumOf(v)?.kind === 'deps');
        const masterFiles = other.reduce((s, v) => s + (sumOf(v)?.masterFiles ?? 0), 0);
        const parts: string[] = [];
        if (reb.length) {
            parts.push(`${plural(reb.length, 'rebase seul', 'rebases seuls')}${masterFiles ? ` (${masterMasked(masterFiles)})` : ''}`);
        }
        if (deps.length) {
            parts.push(`${plural(deps.length, 'version')} de dépendances`);
        }
        const rest = other.length - reb.length - deps.length;
        if (rest) {
            parts.push(`${plural(rest, 'autre')} sans changement de l'auteur`);
        }
        lines.push([`${plural(other.length, 'version')} sans code : ${parts.join(', ')}`]);
    } else if (other.length) {
        const segs: Seg[] = [];
        [...other].reverse().forEach((v, k) => {
            if (k) {
                segs.push(' · ');
            }
            segs.push(...versionLine(v, sumOf(v)));
        });
        lines.push(segs);
    }
    if (comments) {
        lines.push(comments);
    }
    if (msgChanged) {
        lines.push(['message du commit modifié']);
    }
    return { ...base, variant: 'since', head, lines, action: 'mark', rule: true };
}
