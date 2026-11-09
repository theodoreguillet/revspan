// Descriptions de versions et de fichiers (bandeau de reprise, onglet Versions, infobulles).
import type { Version, VersionSummary } from '../../shared/api.ts';
import type { Translator } from '../i18n/index.ts';
import { basename, masterMasked, MINUS } from './format.ts';
import { add, del, mono, tSegs, type Seg } from './segments.ts';

type FileRef = { path: string };

/** « a.ts, b.ts et c.ts » or « a.ts, b.ts, c.ts et 2 autres ». */
export function filesText(tr: Translator, files: FileRef[], max = 3): string {
    const names = files.map((f) => basename(f.path));
    if (names.length <= max) {
        return tr.list(names);
    }
    return tr.t('common.andOthers', { files: names.slice(0, max).join(', '), count: names.length - max });
}

/** Same, with the names in monospace. */
export function filesSegs(tr: Translator, files: FileRef[], max = 3): Seg[] {
    const names = files.map((f) => basename(f.path));
    if (names.length <= max) {
        return tr.listParts(names).map((part) => (typeof part === 'string' ? part : mono(part.element)));
    }
    const shown = names.slice(0, max).flatMap((name, k): Seg[] => (k ? [', ', mono(name)] : [mono(name)]));
    return tSegs(tr, 'common.andOthers', { files: shown, count: names.length - max });
}

/** Type shown in the Versions tab. */
export function versionTypeBadge(tr: Translator, v: Version): { label: string; cls: string } {
    if (v.index === 1) {
        return { label: tr.t('versionType.creation'), cls: 'rv-kind c' };
    }
    return v.isRebase ? { label: tr.t('versionType.rebase'), cls: 'rv-kind r' } : { label: tr.t('versionType.amend'), cls: 'rv-kind' };
}

/** « Changed by the author » column of the Versions tab. */
export function changedSegs(tr: Translator, v: Version, sum: VersionSummary | undefined): Seg[] {
    if (!sum) {
        return ['…'];
    }
    const masked = sum.masterFiles ? ` · ${masterMasked(tr, sum.masterFiles)}` : '';
    const msg = v.messageChanged ? ` · ${tr.t('versions.messageEdited')}` : '';
    switch (sum.kind) {
        case 'creation':
            return [`${tr.t('versions.initialPr')} · `, add(`+${sum.added}`), ' ', del(`${MINUS}${sum.removed}`), ` · ${tr.t('common.files', { count: sum.files.length })}`, msg];
        case 'code':
            return [add(`+${sum.added}`), ' ', del(`${MINUS}${sum.removed}`), ` · ${filesText(tr, sum.files, 4)}`, masked, msg];
        case 'deps':
            return [v.isRebase ? tr.t('versions.depsOnly') : filesText(tr, sum.files, 4), masked, msg];
        case 'message-only':
            return [tr.t('common.commitMessageOnly')];
        default:
            return [`${tr.t('kind.none')}${masked}`, msg];
    }
}
