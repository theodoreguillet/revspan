# Revspan

Review a Bitbucket PR **version by version**: every push is a version, even when the author runs
`git commit --amend` and rebases on every round of feedback (one PR = one commit). Bitbucket only shows the full diff
against master; Revspan finds every pushed version and shows what the author really changed between two versions,
without the noise brought in by rebases.

Local tool: a Node server (TypeScript, Hono) that serves a Vue 3 page in your browser.

## Run

```bash
npm ci && npm run build                              # once (then after each update)
node bin/revspan.js                                   # "My PRs" home page
node bin/revspan.js https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>   # open a PR directly
```

Node 22.18 or later. The page opens on `http://127.0.0.1:7420` (`--port 7500` and `--no-open` are available).
Handy: `alias revspan='node /path/to/revspan/bin/revspan.js'`.

### CLI security

The command draws a new secret at each start and opens (and prints, `--no-open` included)
`http://127.0.0.1:7420/open?k=<secret>`; the browser keeps it as a cookie, and the local API answers nothing without
it. Another user of the same machine therefore can no longer read your PRs, diffs, comments or settings through
Revspan, nor comment, approve, request changes or change your settings as you, even though the server listens on
127.0.0.1. The secret never goes into a process argument that other users could list: on macOS the browser is opened
through `osascript` reading the address on its standard input, on Linux through a temporary page (mode `0600`, in the
configuration folder, deleted after 10 seconds) given to `xdg-open`, on Windows through `explorer.exe` (other standard
users cannot read another user's command line). If the page says "Open Revspan from the revspan command", open the
printed address again, or run `revspan` again: while one runs, a second `revspan [PR URL]` opens the running one
instead of starting another. Two limits:

- the `?k=` address stays in your browser history, which only your own account can read;
- browsers send the cookies of 127.0.0.1 to every port. If the preferred port (7420, or `--port`) is taken, Revspan
  starts on the next free one and prints a warning: do not open the taken port in that browser, since the program
  holding it would receive your Revspan cookie.

## Language

The interface exists in French and English. The language is chosen automatically:

- **VS Code extension**: follows VS Code's display language (French if it starts with `fr`, English otherwise). The
  page shown in the panel uses the same language, not the browser's.
- **Browser page**: follows the browser's preferred language (French for `fr*`, English otherwise).
- **Terminal output** (command line, server logs): English only.

Code comments, tests and documentation are in English. The translation catalogs are
`src/web/i18n/{en,fr}.ts` for the page, and `extension/package.nls*.json` and `extension/l10n/` for the extension.

## VS Code extension

The same page exists as a VS Code extension: a **"My PRs"** view in the activity bar (Revspan icon) with the review queue and notifications (see below),
each PR in its own editor tab (the home page and the settings share one "Revspan" tab; opening a PR that already has a
tab shows that tab), and two actions on each file of the diff:

- **Open file**: the file from the repository cloned in the workspace, at the line. The clone is found by its Bitbucket
  remote (`<workspace>/<repo>`, https or ssh), otherwise by its folder name, and the git worktrees of the repository
  (wherever they are, bare repositories included) are considered too. A worktree checked out on the PR's branch is
  preferred over the main copy (otherwise a message warns that the lines may differ). The path must stay inside the
  repository.
- **VS Code diff**: the file's comparison in the native diff editor (syntax highlighting), with exactly the same two
  sides as the page (version replayed onto the new base after a rebase).

There is no server or port: the extension calls the application in memory. The token is stored in VS Code's secure
storage (⚙ Settings of the panel or the "Revspan: Settings" command), separately from the web version; VS Code
shares it across profiles. The tracked repositories are the VS Code setting `revspan.repositories`: it can also be
edited from VS Code's Settings, is synced by Settings Sync and is specific to each profile (unlike the token). After "Reload Window", VS Code
restores every Revspan tab (the home and each PR) on the page it showed, without duplicates.

```bash
npm run extension:install            # builds dist/revspan.vsix and installs it in VS Code (then reload the window)
npm run extension:install -- --profile "Name"   # same in a specific VS Code profile (otherwise: default profile)
npm run package:extension            # only the .vsix (to share: Extensions › … › Install from VSIX)
npm run extension:dev -- <folder>    # development mode: VS Code window on <folder>, extension not installed
```

Or open the `revspan` folder in VS Code and run "Revspan Extension" (F5).

## First launch: the token

1. Create an Atlassian API token **with scopes** at <https://id.atlassian.com/manage-profile/security/api-tokens>
   ("Create API token with scopes", Bitbucket app):
   `read:user:bitbucket`, `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`.
2. In Revspan, ⚙ Settings: your Atlassian e-mail + the token, then "Test connection".
3. Adjust the home page's repository list (one `workspace/repo` per line).

The token is stored in the **macOS keychain** (service `revspan-bitbucket`), through `secret-tool` on Linux,
otherwise in a `token.json` file with mode `0600`. It never leaves the local server.
Without `read:user:bitbucket`, the tool works but does not recognize your PRs or your approvals.

## Review queue

The home page answers "what waits for me?". A PR **needs review** while it has fewer approvals than the minimum.
Approvals are counted the way Bitbucket counts them for the merge rule: the `approved` flag of every participant
except the author, **your own approval included**. The minimum is 2 by default, with an optional override per
repository. An invalid value (0, negative, not a whole number) falls back to the default.

Five groups, shown in this order: `to-do` ("To review"), `to-rebase` ("To rebase"), `mine` ("My PRs"), `waiting`
("Waiting on the author") and `others` ("Other open PRs"). For one PR, these rules are tried **in this order** and the
first that matches wins:

| # | Rule | Group |
|---|---|---|
| 1 | The token cannot read your profile (no `read:user:bitbucket`); the page says why. | `others` |
| 2 | You are the author (a draft included): `to-rebase` when the destination branch moved since the PR's base, `mine` otherwise. | `to-rebase` / `mine` |
| 3 | The PR is a **draft** (not ready for review). | `others` |
| 4 | You approved the latest version, or your approval still holds because only rebase-only pushes arrived since (Bitbucket keeps it). | `waiting` |
| 5 | You are a designated reviewer, you **requested changes**, and only neutral versions arrived since. | `waiting` |
| 6 | You are a **designated reviewer** (and none of the above). | `to-do` |
| 7 | You reviewed (approved or marked it) or requested changes, and only neutral versions arrived since. | `waiting` |
| 8 | It needs review (fewer approvals than the minimum) and its author is followed, or you follow nobody. | `to-do` |
| 9 | You reviewed, approved or requested changes and code or dependencies changed since (a version whose type is not computed yet counts as code). | `to-do` |
| 10 | Anything else: enough approvals, nothing asked of you. | `others` |

A designated reviewer who commented without approving stays in `to-do` (rule 6), since Bitbucket explicitly asks for
their approval.

**Followed contributors narrow "To review".** While you follow nobody, every PR needing review is in "To review", so a
new user never sees an empty list. Once you follow at least one person, "To review" keeps only the PRs of followed
authors, the ones where you are a designated reviewer, and the ones you reviewed, approved or requested changes on whose code changed since
(you are already engaged with them); any other PR needing review goes to "Other open PRs". Follow someone from a PR row
(☆ Follow), from the PR header, or from Settings › Followed contributors (**Add** lists the authors of the open PRs in
your repositories).

**Hiding unfollowed contributors** (`revspan.review.hideUnfollowed`, on by default): the home page and the VS Code tree
leave out the PRs of authors you do not follow. Your own PRs ("To rebase", "My PRs"), the PRs where you are a designated
reviewer and the ones you reviewed or approved are always shown, and nothing is hidden while you follow nobody. The page
and the tree show how many PRs are hidden, with a link to the settings. It is a display filter only: notifications and the request
budget are unchanged.

**Searching** (field in the top bar, `/` to focus it, `Esc` to clear): a case- and accent-insensitive substring of the PR title, its `#number`, its repository or its author's name. It applies on top of the unfollowed filter to every group and subgroup, hides what does not match, counts the matches and opens "Other open PRs" while it holds some. Nothing is requested and the text is not kept when you leave the page; the VS Code tree is unchanged.

"To review" and "Other open PRs" can be grouped by repository, by contributor or not at all. "To rebase" and "My PRs"
are always by repository and "Waiting" is never grouped. The choice is stored **separately** for the page (browser) and
for the VS Code tree. Inside each group the PRs are sorted newest push first. Repository subgroups are sorted by their most
recent PR; contributor subgroups are sorted alphabetically by name (the unknown author last), so they do not move when someone pushes.

### Settings

In VS Code these are Settings (profile and Settings Sync apply). In the browser version they live in the page's
Settings screen and in `config.json`.

| Setting | Default | Meaning |
|---|---|---|
| `revspan.repositories` | `[]` | Tracked repositories, one `workspace/repo` per entry. |
| `revspan.review.requiredApprovals` | `2` | Approvals a PR needs (1 to 20). |
| `revspan.review.requiredApprovalsByRepository` | `{}` | Override per repository, `{ "workspace/repo": n }`. A key that is not a tracked repository is ignored. |
| `revspan.review.followedContributors` | `[]` | Followed authors (`{ uuid, displayName }`), managed from the "Follow" action on a PR row or from Settings (**Add**). Once someone is followed, "To review" is limited to followed, designated and engaged PRs. |
| `revspan.review.hideUnfollowed` | `true` | Hide the PRs of contributors you do not follow (yours, designated and reviewed ones stay; no effect while nobody is followed). |
| `revspan.notifications.newPullRequest` | `true` | Notify a new PR needing review from a followed contributor, or one where you are a designated reviewer. |
| `revspan.notifications.newVersion` | `true` | Notify a new code or dependencies version on a PR you reviewed or approved. |
| `revspan.notifications.buildFailed` | `false` | Notify a failed build on one of your own PRs. |
| `revspan.refreshIntervalMinutes` | `5` | Background refresh interval (1 to 120). |

`revspan.repositories`, `revspan.review.requiredApprovalsByRepository`, `revspan.review.followedContributors`,
`revspan.review.hideUnfollowed`, `revspan.refreshIntervalMinutes` and the three `revspan.notifications.*` settings are
`restrictedConfigurations`: VS Code ignores a value set by an untrusted workspace.

After an update of the extension, VS Code only knows a new setting once the window is reloaded. Saving it before that
shows "Revspan was just updated: reload the VS Code window (Developer: Reload Window) to save settings." instead of an
internal error.

### Notifications (VS Code)

- **New PR needing review**: a followed contributor opened it, or you are a designated reviewer (you are told until you
  approve; a PR already seen is notified once for that designation).
- **New version**: a PR you reviewed or approved has a new head with code or dependencies. Rebase-only, message-only or
  erased versions **never** notify.
- **Build failed**: a build of one of your own PRs ("To rebase" or "My PRs") failed (off by default).

Draft PRs never notify; once ready for review, a draft is treated like a new PR.

Guarantees: one notification per PR and head, even with several windows; none on first run and no backlog when an
option is switched on (a silent baseline is recorded per repository); only tracked repositories. Windows tracking
different repositories (workspace settings) share what was notified without silencing each other; a repository removed
from the settings is forgotten, so tracking it again records a new silent baseline. A PR whose head
changed while VS Code was closed notifies once at the next poll. At most **3** notifications per poll (failed builds,
then new PRs, then new versions), followed by one summary. The background refresh starts when VS Code starts
(`onStartupFinished`) and does nothing, with no request, when the three options are off and neither the view nor the
panel is visible.

### Build status

Generic: Revspan reads the statuses Bitbucket attaches to the PR's latest commit
(`GET /repositories/{workspace}/{repo}/commit/{head}/statuses`, one request), whatever CI publishes them. It never calls a
CI. A badge shows the aggregate (`failed`, `running`, `success`, or nothing) on the cards and in the PR header, and the
PR page has a **Builds** tab listing each check with its link.

For the first hour after a push, the checks are read again once per interval even when they all look finished: a
second CI (tests after lint, for example) may not have posted yet. Past that hour, finished checks are kept for that
commit and never read again by the home.

Known trade-offs:

- a re-run on the same commit more than an hour after the push shows when the PR page is opened, or, for your own PRs,
  with **Refresh**;
- a CI that posts its first status more than 1 hour after the push is treated as "no CI" for that commit on the home
  page (the PR page still shows it).

### Needs rebase and merge conflicts

On your own open PRs, a flag appears when the destination branch head differs from the PR's merge base, meaning the
destination moved since the base (never on a merged or declined PR); these PRs are listed in "To rebase" instead of "My
PRs". The destination head is read **once per repository and per interval**.

The PR page shows the same state for any open PR, yours or a colleague's: an orange "Needs rebase on master" chip when
the PR is behind its destination, and a red "⚠ Conflicts with master · 3 files" chip when Bitbucket reports merge
conflicts (`GET .../pullrequests/{id}/conflicts`). Its tooltip lists the files, and a click opens the first one shown
in the diff, where the file list marks it ⚠ "Merge conflict with master" (the ⚠ of the rebase heuristic keeps its
own title). Conflicts are read only for a PR that is behind: a PR based on the destination's head cannot conflict. An
up-to-date PR shows nothing. They are read once per pair of source and destination heads, with a 5 s limit: the page
waits at most 5 s for them, and a slower answer only leaves the chip out.

### Request budget

Revspan keeps its load on Bitbucket low. Measured on the fake Bitbucket (one repository, 8 PRs). The home rows count
HTTP requests; the PR page rows count reads (a read of several pages, like the activity of a long PR, counts once):

| Situation | Requests |
|---|---|
| First refresh (cold) | 32 |
| Steady state, next interval | **3** (was 30): the PR list, the destination head, the one running build |
| Two windows, in phase | **3** (was 60) |
| Two windows, out of phase | 3, then 0 for the second window that reuses the first one's result |
| After one code push on a PR you reviewed, with the version check | **19** (was 47) |
| Explicit Refresh of the home (VS Code command or the home page's Refresh button) | **3** (was 30) |
| A repository fails (rate limit, outage), second window within 60 s | **0**: the failed home is shared for 60 s |
| Reopening a PR within the refresh interval (tab closed and reopened, same comparisons) | **0**: the loaded PR and its comparisons are kept for `review.refreshMinutes`; a write, ↻ or a later open reads again |
| PR page left open (periodic check) | **1** read of the PR per refresh interval per visible PR page; 0 for a hidden tab; pages checking within 15 s of each other or of a fresh load share it |
| Changing the range on a PR page | **0** for the presets (prefetched) and any range already computed within the interval (3.3.0: 4 on the main PR) |
| ↻ on a PR page | **5** on the main PR: the PR, its activity, its comments, the build statuses and the destination head (3.3.0 page reload: 4); the diff is computed again only if its range changed or a new thread lacks its place |
| A write (comment, reply, resolve, edit, delete) | the write + one fresh detail: **+3** (the PR, its activity, its comments; the merge conflicts are not read again); task writes: the write + **1** (the PR's pulse, for the open count) |
| Opening a local file from VS Code | **0** while the PR is loaded (3.3.0: 3 to 4) |
| Opening a PR of ≤ 30 files: up to 3 extra comparisons in the background (prefetch), none for larger PRs or hidden tabs | **+1** on the main PR (48 → 49, cold caches): 2 comparisons, the third preset being the diff shown, mostly reuse what the version summaries already read |
| Opening a PR: rebase state (any open PR) | up to date: no conflicts read (destination head cached 60 s and shared with the home, merge base on disk); behind: **+1** paginated conflicts read (2 HTTP requests: Bitbucket redirects it), once per source and destination head. Reopening within the interval reads nothing |
| Tasks tab | **0** until it is opened (the open count comes from the PR already read); opening it: **1** paginated read (100 tasks per page), again on ↻ while it is open |

Windows share the computed home through `home.json` (the last home of each profile: VS Code profiles share the storage
directory, up to 4 homes kept), `home-<identity>.lock` (one lease per home, so only one window computes it, while a
window computing another profile's home is not waited for) and `home.drop` (a counter bumped on every write, so a
result computed before a write is not reused), all in the config or storage directory. In VS Code, the "Revspan"
output log (View › Output) has one line per "My PRs" load: duration, time waited for another window, the hashed home
identity and error codes, no PR data. Trade-off: with several windows, a new push can show up after up to
about **1.5 intervals** instead of 1. A home with a repository error is shared for 60 s only, so the error is tried
again soon without every window recomputing on every poll. During the hour after a push, that PR's build checks cost
one request per interval even once finished (see "Build status").

## A PR page

- **Version timeline**: one symbol per push, grouped by day: a round dot with a **C** = a commit (code pushed), an
  orange diamond with an **R** = a rebase, a dashed outline = unavailable version (erased by Bitbucket), a small blue
  dot = new to you. Under each symbol, what the author changed
  (`+35 −14`, `deps` = only package.json / lockfile / submodule, `rebase only`, `message`).
  Hovering a symbol shows two short lines: what the version is (`v6 · rebase + code (+3 −1)`), then its date and flags.
  Click = what this version changed; click it again = the whole version against master (a third click goes back);
  Shift+click = extend the range; "master" = full version.
  On a long PR the oldest versions are folded into one block; click it to expand, then **Fold** (next to the presets) to
  fold them again.
- **Resume**: a "✓ reviewed" mark on your last review (approval or "Mark as reviewed", never a comment or a change request),
  a banner with what moved since, blue dots on the new versions.
- **Diff**: unified or side by side (an added or removed file always unified), "seen" files (the tick is dropped if
  the file changes; **Mark all viewed** or `Shift+V` ticks every listed file in one request), files coming from master
  hidden. The toolbar stays under the timeline while scrolling. A range the page has not computed yet keeps the current
  diff with a progress bar, then shows placeholder files after 200 ms; the presets (since your review, last version,
  all) are computed in the background for a PR of up to 30 files, so switching to them is instant.
  Syntax highlighting with the VS Code themes (Dark+ / Light+, following the VS Code or browser theme), for the
  common languages (TypeScript, JavaScript, Vue, JSON, YAML, Markdown, CSS, HTML, Python, Java, Go, Rust, shell, PHP,
  Ruby, Kotlin, C#, SQL, XML, Dockerfile, Makefile).
- **Search** (box at the top of the file list, `/`): the list keeps the files whose path contains the text, or whose
  lines shown contain it (case-insensitive, at least 2 characters; with "whole file" on, the whole file is searched).
  Each file shows its match count; Enter / Shift+Enter go to the next / previous match across files (a collapsed or
  seen file opens), Esc clears. All in the page: no request to Bitbucket.
- **Go to definition** (Ctrl+click, ⌘+click on macOS, on a name in the diff, either view and side): the line that
  defines it among the lines shown, reached like a search match (file opened, line under the toolbar, flashed). The
  clicked file comes first, then the others in list order; the new side first, removed lines only when the new side has
  none. Several definitions: a list under the click (↑/↓, Enter, Esc). None shown: its import in the same file, with
  **Search <file> (whole file)** when the import points to a file of the PR (turns "whole file" on and looks there);
  nothing at all: a short notice (suggesting "whole file" when it is off). `Alt+←` (or the **← back** chip, 5 s) goes
  back; the places to go back to are kept until the compared range changes, and `Alt+←` is the page's only while there
  is one (in the VS Code panel on Windows, `Alt+←` stays VS Code's Go Back: use the chip). Holding the modifier
  underlines the names. Level 1 only, no request and no language server: a small pattern
  table per language family (TypeScript / JavaScript / Vue; Python; Java, Kotlin, C#, Go, Rust, PHP, Ruby) in
  `src/web/lib/goto-definition.ts`. Strings, comments, numbers and keywords are told apart by their Dark+ / Light+
  syntax color, plus a keyword list per family for lines not colored yet.
- **Discussions**: threads relocated onto the displayed version ("line modified since"), replies, 👍, resolution
  (**Reopen** on the folded bar of a resolved thread); comment on a line of the latest version; **Edit** or delete your
  own comments. A comment, a reply, a 👍 or a resolution shows at once, then Bitbucket's answer replaces it.
- **Tasks** (tab after Builds, with the open count): the PR's Bitbucket tasks, read when the tab is opened. Tick or
  reopen a task, delete yours, add one with the input at the bottom; a task created under a comment links to its
  thread ("see the comment").
- **Approve / request changes**, with the version each person approved ("stale" if code changed since).
  An approval that Bitbucket keeps after rebase-only pushes stays valid: nothing to re-approve. The new state shows as
  soon as Bitbucket accepts it. Only an approval or "Mark as reviewed" counts as a review: a comment or a change request
  does not.
- **Rebase and conflicts**: "Needs rebase" and "⚠ Conflicts" chips in the header (see "Needs rebase and merge
  conflicts").
- **↻ Refresh** reads the PR again (comments, approvals, versions) and says what came in ("2 new comments", "Up to
  date"); the shown diff stays unless its range changed. While the page is visible, a light check (one read of the PR)
  runs at the refresh interval of the settings: news shows a banner with a Refresh button, the page never changes by
  itself. Reopening a PR within that interval shows it at once, with no read.

Shortcuts: `j`/`k` file, `n`/`p` thread, `v` seen, `Shift+V` all files seen, `[`/`]` version, `/` search,
`Ctrl+click` (`⌘+click`) go to definition, `Alt+←` back, `?` help. On AZERTY keyboards, `[`
and `]` typed with Option or AltGr work too.

## Develop

| Command | Role |
|---|---|
| `npm ci` | dependencies from the lockfile |
| `npm run dev` | server in watch mode (port 7420) + Vite with hot reload (port 5173) |
| `npm run dev:fake` | server wired to the fake Bitbucket (no real call), prints its `?k=` addresses; then `npm run dev:web` |
| `npm run check` | lint + types + unit and integration tests (Vitest) |
| `npm run test:e2e` | build then Playwright UI tests on the real server wired to the fake Bitbucket |
| `npm run test:perf` | build then measures the diff's long tasks on a large PR of the fake Bitbucket (file switch, j/k, big file, search, context); `REVSPAN_PERF_CPU=4` slows the CPU, not part of `check` |
| `npm run test:live` | real read-only test on a PR of your choice (`REVSPAN_LIVE_PR` = URL, `REVSPAN_LIVE_EMAIL`, `REVSPAN_KEYCHAIN_SERVICE`) |
| `npm run build:extension` / `npm run test:extension` | builds the VS Code extension / smoke test in an isolated VS Code (fake Bitbucket) |
| `npm run package:extension` / `npm run extension:install` | `.vsix` in `dist/` (vsce) / builds it and installs it in VS Code |
| `npm run build` / `npm start` / `npm run clean` | builds `dist/` / runs the built tool / removes the builds |

The project's `.npmrc` contains `ignore-scripts=true`: npm runs no dependency install script
(none of them needs one). The Playwright tests use macOS's Python 3.10 by default (another interpreter through the
`PYTHON` variable).

The GitHub Actions CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint, types, tests and UI tests, and
builds the `.vsix` (downloadable artifact). Pushing a tag `vX.Y.Z` equal to the version in `package.json` creates a
GitHub release with the `.vsix`; update the CHANGELOG first.

```
src/shared/api.ts      API contract (types shared by server and page)
src/server/
  core/                pure rules: diff (Myers), 3-way merge, relocation, comparison, PR model
  bitbucket/           Bitbucket REST client and raw types
  infra/               configuration, token (keychain), disk cache
  services/            session, settings, PR, home page
  http/                Hono application: security, routes, zod schemas
  app.ts · main.ts     assembly and command line
src/web/               Vue 3 page (views, components, composables, lib/ = tested rules, i18n/ = catalogs)
src/extension/         VS Code extension: panel (webview), "My PRs" view, native diff, local files; lib/ = tested rules
extension/             extension manifest and translations; dist/ built by `npm run build:extension`
scripts/               dev (server + Vite), extension build
test/                  unit · web · integration · e2e (Playwright) · live · support (fake Bitbucket with 6 PRs)
```

Stack: strict TypeScript 5.9, Hono 4 + zod 4 on the server, Vue 3.5 + vue-router + Vite 8 on the page, Vitest 5,
ESLint 9 (typescript-eslint, eslint-plugin-vue). The server also runs directly from the
sources (`node src/server/main.ts`, Node 22's native type stripping).

## How rebase noise is removed

To compare A → B: only the files the PR touches (in A or in B) are candidates, the others come from master.
If B was rebased, A is first **replayed onto the new base** by a line-by-line 3-way merge, then compared
with B: the lines master changed in `package-lock.json`, `package.json` or `changelog.md` disappear, only
the author's remain. Details: [docs/DESIGN.md](docs/DESIGN.md). Routes: [docs/API.md](docs/API.md).

## Known limits

- **Old versions erased**: Bitbucket eventually deletes the commits overwritten by a force-push, including ones
  Revspan already cached. These versions stay in the timeline, marked "unavailable" (dotted point), and cannot be
  compared; the next version is summarized against the last version that is still readable (or the base), and a
  thread placed on an erased version is shown at file level.
- **Like**: the Bitbucket API has no reactions. A 👍 is posted as a reply "👍" (visible as such in Bitbucket); replies
  made of a single emoji are shown as reactions under the comment they answer and are not counted as comments. Clicking
  👍 again deletes your reply. The periodic check cannot tell them apart: someone else's 👍 shows as a new comment in
  its banner.
- **Comment on a line**: only on the latest version (Bitbucket anchors comments on the current version). On a deleted
  line, the tool posts a general comment that quotes the line.
- **Go to definition** reads patterns on the displayed lines, not the code: a local name defined in several functions
  lists them all, a definition outside the hunks is found only with "whole file" (or through its import), and only
  relative TS / JS imports lead to a file of the PR (no path aliases such as `@/`, no Python or Java packages).
- **Large repositories**: Revspan reads the first 200 open PRs of a repository (4 pages of 50). Beyond that, the home
  page and the VS Code view say the list was cut, and the PRs left out are neither shown nor notified until they come
  into the first 200.
- `npm audit` reports moderate alerts in the lint tooling (minimatch via typescript-eslint, with no fix
  other than a downgrade); nothing in what runs at use time.

## Local data

`~/.config/revspan/` (`%APPDATA%\revspan` on Windows; `REVSPAN_CONFIG_DIR` to change it):
`config.json` (e-mail, repositories, review settings), `state.json` (reviewed versions, seen files, notifications already shown), `run.json` (port, secret and process id of the running `revspan` command, mode `0600`, removed when it stops), `home.json` / `home-<identity>.lock` / `home.drop` (shared home snapshot: PR titles and authors, mode `0600`), `cache/` (immutable contents per commit, paths in merge conflict per pair of PR heads,
and each PR's activity as the home reads it: pushes with their source and destination branch names, repositories and commit hashes, approvals and change requests with user id and date, comments with id, date, author id and reply link, never any comment text except a single emoji (a reaction); can be deleted safely). Several windows (browser tabs, VS Code windows) can share the same folder: the files are
re-read when they change and written atomically, so marks made in one window are not lost in another.

## License

[MIT](LICENSE). Version history: [CHANGELOG.md](CHANGELOG.md).
