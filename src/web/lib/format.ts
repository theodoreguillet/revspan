// Formats de dates, durées et nombres en français.
import type { User } from '../../shared/api.ts';

const DAY_MS = 86400000;
const DAY_FMT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const DAY_YEAR_FMT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const MONTH_FMT = new Intl.DateTimeFormat('fr-FR', { month: 'short' });
const FULL_FMT = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short' });

export const MINUS = '−';

type DateLike = string | number | Date;

const toDate = (value: DateLike): Date => (value instanceof Date ? value : new Date(value));
const pad = (n: number): string => String(n).padStart(2, '0');

/** « 14 oct. » (avec l'année si ce n'est pas l'année en cours). */
export function fmtDay(value: DateLike): string {
    const d = toDate(value);
    return d.getFullYear() === new Date(Date.now()).getFullYear() ? DAY_FMT.format(d) : DAY_YEAR_FMT.format(d);
}

/** « juin », « sept. » */
export function fmtMonth(value: DateLike): string {
    return MONTH_FMT.format(toDate(value));
}

/** « 14/10 11:10 » (heure locale). */
export function fmtDateTime(value: DateLike): string {
    const d = toDate(value);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtFull(value: DateLike): string {
    return FULL_FMT.format(toDate(value));
}

/** Clé de jour local AAAA-MM-JJ. */
export function dayKey(value: DateLike): string {
    const d = toDate(value);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Jour (UTC) d'une clé AAAA-MM-JJ. */
function dayNumber(key: string): number {
    const [year = 1970, month = 1, day = 1] = key.split('-').map(Number);
    return Date.UTC(year, month - 1, day) / DAY_MS;
}

/** Nombre de jours calendaires entre deux clés de jour. */
export function daysBetween(keyA: string, keyB: string): number {
    return Math.round(dayNumber(keyB) - dayNumber(keyA));
}

export function isToday(value: DateLike): boolean {
    return dayKey(value) === dayKey(Date.now());
}

/** Écart entre deux jours de la frise : « 15 j », « 3 sem. », « 2 mois ». */
export function gapLabel(days: number): string {
    if (days < 21) {
        return `${days} j`;
    }
    if (days < 60) {
        return `${Math.round(days / 7)} sem.`;
    }
    return `${Math.round(days / 30.4)} mois`;
}

/** Date relative d'un commentaire : « il y a 2 h », sinon « 3 nov. ». */
export function relTime(value: DateLike): string {
    const diff = Date.now() - toDate(value).getTime();
    if (diff < 60000) {
        return 'à l\'instant';
    }
    if (diff < 3600000) {
        return `il y a ${Math.floor(diff / 60000)} min`;
    }
    if (diff < DAY_MS) {
        return `il y a ${Math.floor(diff / 3600000)} h`;
    }
    return fmtDay(value);
}

/** Ancienneté courte : « il y a 2 h », « il y a 3 j », « il y a 2 sem. », « il y a 3 mois ». */
export function ago(value: DateLike): string {
    const diff = Date.now() - toDate(value).getTime();
    if (diff < 3600000) {
        return diff < 60000 ? 'à l\'instant' : `il y a ${Math.floor(diff / 60000)} min`;
    }
    if (diff < DAY_MS) {
        return `il y a ${Math.floor(diff / 3600000)} h`;
    }
    const days = Math.floor(diff / DAY_MS);
    if (days < 14) {
        return `il y a ${days} j`;
    }
    if (days < 60) {
        return `il y a ${Math.round(days / 7)} sem.`;
    }
    return `il y a ${Math.round(days / 30.4)} mois`;
}

/** « ouverte depuis 22 j » */
export function openedSince(value: DateLike): string {
    const days = Math.floor((Date.now() - toDate(value).getTime()) / DAY_MS);
    if (days < 1) {
        return 'ouverte aujourd\'hui';
    }
    if (days < 60) {
        return `ouverte depuis ${days} j`;
    }
    return `ouverte depuis ${Math.round(days / 30.4)} mois`;
}

/** plural(3, 'version') → « 3 versions » ; plural(1, 'nouveau fil', 'nouveaux fils') → « 1 nouveau fil ». */
export function plural(n: number, singular: string, pluralForm?: string): string {
    return `${n} ${n > 1 ? pluralForm ?? `${singular}s` : singular}`;
}

/** « 137 fichiers de master masqués » / « 1 fichier de master masqué » */
export function masterMasked(n: number): string {
    return `${plural(n, 'fichier')} de master ${n > 1 ? 'masqués' : 'masqué'}`;
}

/** Nom d'une version : 0 = master. */
export const vname = (i: number): string => (i === 0 ? 'master' : `v${i}`);

export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

export const dirname = (p: string): string => p.slice(0, p.lastIndexOf('/') + 1);

/** Liste française : « a, b et c ». */
export function frList(items: string[]): string {
    if (items.length <= 1) {
        return items.join('');
    }
    return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

export function displayName(user: User | null | undefined): string {
    return user?.displayName ?? '?';
}

export function firstName(user: User | null | undefined): string {
    const name = displayName(user);
    const space = name.indexOf(' ');
    return space > 0 ? name.slice(0, space) : name;
}
