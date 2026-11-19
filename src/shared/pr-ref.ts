// Shape rules of a Bitbucket PR reference (shared by the server, the page and the extension).

/** Characters allowed in a workspace or repository slug. */
export const SLUG = /^[A-Za-z0-9._-]+$/;

/** A slug that cannot climb or stay in a path (`.` and `..`). */
export const notDotSegment = (s: string): boolean => s !== '.' && s !== '..';

export const isSlug = (s: string): boolean => SLUG.test(s) && notDotSegment(s);
