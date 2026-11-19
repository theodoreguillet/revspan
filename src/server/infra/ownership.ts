// Trust rule for the CLI's private files (run.json, the Linux redirect page) and their folder, on POSIX: owned by this
// user and writable by nobody else. Without a uid (Windows, where file modes do not express this), the rule is skipped.
import fs from 'node:fs';

/** Owned by `uid`, with no group or other write bit; always true when `uid` is null. */
export const isPrivateStat = (stat: fs.Stats, uid: number | null): boolean => uid === null || (stat.uid === uid && (stat.mode & 0o022) === 0);

/** An existing folder where a private file may be written (false if missing, not a folder, or not private). */
export function isPrivateFolder(dir: string, uid: number | null = process.getuid?.() ?? null): boolean {
    try {
        const stat = fs.statSync(dir);
        return stat.isDirectory() && isPrivateStat(stat, uid);
    } catch {
        return false;
    }
}
