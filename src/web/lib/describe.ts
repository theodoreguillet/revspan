// Descriptions de versions et de fichiers (bandeau de reprise, onglet Versions, infobulles).
import type { Version, VersionSummary } from '../../shared/api.ts';
import { basename, frList, masterMasked, MINUS, plural } from './format.ts';
import { add, del, mono, type Seg } from './segments.ts';

type FileRef = { path: string };

/** « a.ts, b.ts et c.ts » ou « a.ts, b.ts, c.ts et 2 autres ». */
export function filesText(files: FileRef[], max = 3): string {
    const names = files.map((f) => basename(f.path));
    if (names.length <= max) {
        return frList(names);
    }
    return `${names.slice(0, max).join(', ')} et ${names.length - max} autres`;
}

/** Même chose avec les noms en police à chasse fixe. */
export function filesSegs(files: FileRef[], max = 3): Seg[] {
    const names = files.map((f) => basename(f.path));
    const shown = names.slice(0, max);
    const out: Seg[] = [];
    shown.forEach((name, k) => {
        if (k > 0) {
            out.push(k === shown.length - 1 && names.length <= max ? ' et ' : ', ');
        }
        out.push(mono(name));
    });
    if (names.length > max) {
        out.push(` et ${names.length - max} autres`);
    }
    return out;
}

/** Type affiché dans l'onglet Versions. */
export function versionTypeBadge(v: Version): { label: string; cls: string } {
    if (v.index === 1) {
        return { label: 'création', cls: 'rv-kind c' };
    }
    return v.isRebase ? { label: 'rebase', cls: 'rv-kind r' } : { label: 'amend', cls: 'rv-kind' };
}

/** Colonne « Changé par l'auteur » de l'onglet Versions. */
export function changedSegs(v: Version, sum: VersionSummary | undefined): Seg[] {
    if (!sum) {
        return ['…'];
    }
    const masked = sum.masterFiles ? ` · ${masterMasked(sum.masterFiles)}` : '';
    const msg = v.messageChanged ? ' · message modifié' : '';
    switch (sum.kind) {
        case 'creation':
            return ['PR initiale · ', add(`+${sum.added}`), ' ', del(`${MINUS}${sum.removed}`), ` · ${plural(sum.files.length, 'fichier')}`, msg];
        case 'code':
            return [add(`+${sum.added}`), ' ', del(`${MINUS}${sum.removed}`), ` · ${filesText(sum.files, 4)}`, masked, msg];
        case 'deps':
            return [v.isRebase ? 'dépendances seulement' : filesText(sum.files, 4), masked, msg];
        case 'message-only':
            return ['message du commit seulement'];
        default:
            return [`rien${masked}`, msg];
    }
}
