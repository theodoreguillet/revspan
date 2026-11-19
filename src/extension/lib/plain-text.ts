const ZERO_WIDTH_SPACE = '\u200B';

/**
 * VS Code renders `[label](command:…)` inside notification text as a clickable link that runs any command. Text coming
 * from a PR (title, author, path, branch, server error) must never form such a link: a zero-width space between `]` and
 * `(` breaks the syntax and is invisible.
 */
export function plainMessageText(text: string): string {
    return text.replaceAll('](', `]${ZERO_WIDTH_SPACE}(`);
}
