// Dates, durations and names, formatted for the page locale (the translator is passed in).
import type { User } from '../../shared/api.ts';
import type { Translator } from '../i18n/index.ts';

const DAY_MS = 86400000;
const DAY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
const DAY_YEAR: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
const MONTH: Intl.DateTimeFormatOptions = { month: 'short' };
const DATE_TIME: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
const FULL: Intl.DateTimeFormatOptions = { dateStyle: 'full', timeStyle: 'short' };
const MEDIUM: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

export const MINUS = '−';

type DateLike = string | number | Date;

const toDate = (value: DateLike): Date => (value instanceof Date ? value : new Date(value));
const pad = (n: number): string => String(n).padStart(2, '0');

/** "Oct 14" (with the year if it is not the current one). */
export function fmtDay(tr: Translator, value: DateLike): string {
    const d = toDate(value);
    return tr.date(d, d.getFullYear() === new Date(Date.now()).getFullYear() ? DAY : DAY_YEAR);
}

/** "Jun", "Sep" */
export function fmtMonth(tr: Translator, value: DateLike): string {
    return tr.date(toDate(value), MONTH);
}

/** "10/14, 11:10 AM" (local time). */
export function fmtDateTime(tr: Translator, value: DateLike): string {
    return tr.date(toDate(value), DATE_TIME);
}

/** "Nov 10, 2026, 1:00 PM" (local time): a date with its year, for tooltips. */
export function fmtMedium(tr: Translator, value: DateLike): string {
    return tr.date(toDate(value), MEDIUM);
}

export function fmtFull(tr: Translator, value: DateLike): string {
    return tr.date(toDate(value), FULL);
}

/** Local day key YYYY-MM-DD. */
export function dayKey(value: DateLike): string {
    const d = toDate(value);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Day (UTC) of a YYYY-MM-DD key. */
function dayNumber(key: string): number {
    const [year = 1970, month = 1, day = 1] = key.split('-').map(Number);
    return Date.UTC(year, month - 1, day) / DAY_MS;
}

/** Number of calendar days between two day keys. */
export function daysBetween(keyA: string, keyB: string): number {
    return Math.round(dayNumber(keyB) - dayNumber(keyA));
}

export function isToday(value: DateLike): boolean {
    return dayKey(value) === dayKey(Date.now());
}

/** Gap between two timeline days: "15d", "3w", "2mo". */
export function gapLabel(tr: Translator, days: number): string {
    if (days < 21) {
        return tr.t('time.gapDays', { count: days });
    }
    if (days < 60) {
        return tr.t('time.gapWeeks', { count: Math.round(days / 7) });
    }
    return tr.t('time.gapMonths', { count: Math.round(days / 30.4) });
}

/** Relative date of a comment: "2h ago", otherwise "Nov 3". */
export function relTime(tr: Translator, value: DateLike): string {
    const diff = Date.now() - toDate(value).getTime();
    if (diff < 60000) {
        return tr.t('time.justNow');
    }
    if (diff < 3600000) {
        return tr.t('time.minutesAgo', { count: Math.floor(diff / 60000) });
    }
    if (diff < DAY_MS) {
        return tr.t('time.hoursAgo', { count: Math.floor(diff / 3600000) });
    }
    return fmtDay(tr, value);
}

/** Short age: "2h ago", "3d ago", "2w ago", "3mo ago". */
export function ago(tr: Translator, value: DateLike): string {
    const diff = Date.now() - toDate(value).getTime();
    if (diff < 3600000) {
        return diff < 60000 ? tr.t('time.justNow') : tr.t('time.minutesAgo', { count: Math.floor(diff / 60000) });
    }
    if (diff < DAY_MS) {
        return tr.t('time.hoursAgo', { count: Math.floor(diff / 3600000) });
    }
    const days = Math.floor(diff / DAY_MS);
    if (days < 14) {
        return tr.t('time.daysAgo', { count: days });
    }
    if (days < 60) {
        return tr.t('time.weeksAgo', { count: Math.round(days / 7) });
    }
    return tr.t('time.monthsAgo', { count: Math.round(days / 30.4) });
}

/** "open for 22 days" */
export function openedSince(tr: Translator, value: DateLike): string {
    const days = Math.floor((Date.now() - toDate(value).getTime()) / DAY_MS);
    if (days < 1) {
        return tr.t('time.openedToday');
    }
    if (days < 60) {
        return tr.t('time.openForDays', { count: days });
    }
    return tr.t('time.openForMonths', { count: Math.round(days / 30.4) });
}

/** "137 master files hidden" */
export function masterMasked(tr: Translator, n: number): string {
    return tr.t('common.masterFilesHidden', { count: n });
}

/** Name of a version: 0 = master. */
export const vname = (i: number): string => (i === 0 ? 'master' : `v${i}`);

export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

export const dirname = (p: string): string => p.slice(0, p.lastIndexOf('/') + 1);

export function displayName(user: User | null | undefined): string {
    return user?.displayName ?? '?';
}

export function firstName(user: User | null | undefined): string {
    const name = displayName(user);
    const space = name.indexOf(' ');
    return space > 0 ? name.slice(0, space) : name;
}
