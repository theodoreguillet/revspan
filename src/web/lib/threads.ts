// Fils de discussion : groupes, activité, nouveaux commentaires, avatars.
import type { Thread, User } from '../../shared/api.ts';
import { firstName } from './format.ts';

export function lastActivity(thread: Thread): string {
    return thread.comments.reduce((max, c) => (c.createdOn > max ? c.createdOn : max), '');
}

export function hasNew(thread: Thread): boolean {
    return thread.comments.some((c) => c.isNew);
}

/** Groupes de l'onglet Discussions, chacun trié par activité récente. */
export function threadGroups(threads: Thread[]): { fresh: Thread[]; open: Thread[]; resolved: Thread[] } {
    const byActivity = (a: Thread, b: Thread): number => lastActivity(b).localeCompare(lastActivity(a));
    return {
        fresh: threads.filter(hasNew).sort(byActivity),
        open: threads.filter((t) => !hasNew(t) && !t.resolved).sort(byActivity),
        resolved: threads.filter((t) => !hasNew(t) && t.resolved).sort(byActivity),
    };
}

/** Nouveaux fils et réponses depuis ma relecture (avec les prénoms des auteurs). */
export function newActivity(threads: Thread[]): { newThreads: number; replies: number; names: string[] } {
    let newThreads = 0;
    let replies = 0;
    const names: string[] = [];
    for (const t of threads) {
        t.comments.forEach((c, k) => {
            if (!c.isNew) {
                return;
            }
            if (k === 0) {
                newThreads++;
            } else {
                replies++;
            }
            const name = firstName(c.user);
            if (!names.includes(name)) {
                names.push(name);
            }
        });
    }
    return { newThreads, replies, names };
}

export function initials(name: string | null | undefined): string {
    const [first, second] = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (!first) {
        return '?';
    }
    return (second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2)).toUpperCase();
}

/** Teinte stable (0..359) dérivée de l'uuid. */
export function avatarHue(user: User | null | undefined): number {
    const s = user?.uuid ?? user?.displayName ?? '?';
    let x = 2166136261;
    for (let k = 0; k < s.length; k++) {
        x ^= s.charCodeAt(k);
        x = Math.imul(x, 16777619);
    }
    return (x >>> 0) % 360;
}
