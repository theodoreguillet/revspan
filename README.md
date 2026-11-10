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

## Language

The interface exists in French and English. The language is chosen automatically:

- **VS Code extension**: follows VS Code's display language (French if it starts with `fr`, English otherwise). The
  page shown in the panel uses the same language, not the browser's.
- **Browser page**: follows the browser's preferred language (French for `fr*`, English otherwise).
- **Terminal output** (command line, server logs): English only.

Code comments, tests and documentation are in English. The translation catalogs are
`src/web/i18n/{en,fr}.ts` for the page, and `extension/package.nls*.json` and `extension/l10n/` for the extension.

## VS Code extension

The same page exists as a VS Code extension: a **"My PRs"** view in the activity bar (Revspan icon) with the review queue and notifications (see below), the PR page
in a panel, and two actions on each file of the diff:

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
reopens the Revspan panel on the page that was displayed.

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

Four groups, shown in this order: `to-do` ("To do"), `mine` ("My PRs"), `waiting` ("Waiting on the author") and
`others` ("Other open PRs"). For one PR, these rules are tried **in this order** and the first that matches wins:

| # | Rule | Group |
|---|---|---|
| 1 | The token cannot read your profile (no `read:user:bitbucket`); the page says why. | `others` |
| 2 | You are the author (a draft included). | `mine` |
| 3 | The PR is a **draft** (not ready for review). | `others` |
| 4 | You approved the latest version, or your approval still holds because only rebase-only pushes arrived since (Bitbucket keeps it). | `waiting` |
| 5 | You are a designated reviewer, you **requested changes**, and only neutral versions arrived since. | `waiting` |
| 6 | You are a **designated reviewer** (and none of the above). | `to-do` |
| 7 | You reviewed or approved it and only neutral versions arrived since. | `waiting` |
| 8 | It needs review (fewer approvals than the minimum). | `to-do` |
| 9 | You reviewed or approved it and code or dependencies changed since (a version whose type is not computed yet counts as code). | `to-do` |
| 10 | Anything else: enough approvals, nothing asked of you. | `others` |

A designated reviewer who commented without approving stays in `to-do` (rule 6), since Bitbucket explicitly asks for
their approval. "To do" and "Other open PRs" can be grouped by repository, by contributor or not at all. "My PRs" is always
by repository and "Waiting" is never grouped. The choice is stored **separately** for the page (browser) and for the
VS Code tree. Followed contributors' PRs come first.

### Settings

In VS Code these are Settings (profile and Settings Sync apply). In the browser version they live in the page's
Settings screen and in `config.json`.

| Setting | Default | Meaning |
|---|---|---|
| `revspan.repositories` | `[]` | Tracked repositories, one `workspace/repo` per entry. |
| `revspan.review.requiredApprovals` | `2` | Approvals a PR needs (1 to 20). |
| `revspan.review.requiredApprovalsByRepository` | `{}` | Override per repository, `{ "workspace/repo": n }`. A key that is not a tracked repository is ignored. |
| `revspan.review.followedContributors` | `[]` | Followed authors (`{ uuid, displayName }`), managed from the "Follow" action on a PR row. |
| `revspan.notifications.newPullRequest` | `true` | Notify a new PR needing review from a followed contributor, or one where you are a designated reviewer. |
| `revspan.notifications.newVersion` | `true` | Notify a new code or dependencies version on a PR you reviewed or approved. |
| `revspan.notifications.buildFailed` | `false` | Notify a failed build on one of your own PRs. |
| `revspan.refreshIntervalMinutes` | `5` | Background refresh interval (1 to 120). |

`revspan.repositories`, `revspan.review.requiredApprovalsByRepository`, `revspan.review.followedContributors`,
`revspan.refreshIntervalMinutes` and the three `revspan.notifications.*` settings are `restrictedConfigurations`: VS Code
ignores a value set by an untrusted workspace.

### Notifications (VS Code)

- **New PR needing review**: a followed contributor opened it, or you are a designated reviewer (you are told until you
  approve; a PR already seen is notified once for that designation).
- **New version**: a PR you reviewed or approved has a new head with code or dependencies. Rebase-only, message-only or
  erased versions **never** notify.
- **Build failed**: a build of one of your own PRs failed (off by default).

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

### Needs rebase

On your own open PRs, a flag appears when the destination branch head differs from the PR's merge base, meaning the
destination moved since the base (never on a merged or declined PR). The destination head is read **once per repository and per interval**.

### Request budget

Revspan keeps its load on Bitbucket low. Measured on the fake Bitbucket (one repository, 8 PRs):

| Situation | Requests |
|---|---|
| First refresh (cold) | 31 |
| Steady state, next interval | **3** (was 30): the PR list, the destination head, the one running build |
| Two windows, in phase | **3** (was 60) |
| Two windows, out of phase | 3, then 0 for the second window that reuses the first one's result |
| After one code push on a PR you reviewed, with the version check | **19** (was 47) |
| Explicit Refresh (VS Code command or the page's ↻ button) | **3** (was 30) |
| A repository fails (rate limit, outage), second window within 60 s | **0**: the failed home is shared for 60 s |

Windows sharing one profile share the computed home through `home.json` (the last home), `home.lock` (a lease so only
one window computes) and `home.drop` (a counter bumped on every write, so a result computed before a write is not
reused), all in the config or storage directory. Trade-off: with several windows, a new push can show up after up to
about **1.5 intervals** instead of 1. A home with a repository error is shared for 60 s only, so the error is tried
again soon without every window recomputing on every poll. During the hour after a push, that PR's build checks cost
one request per interval even once finished (see "Build status").

## A PR page

- **Version timeline**: one dot per push, grouped by day; ◆ = rebase; under each dot, what the author changed
  (`+35 −14`, `deps` = only package.json / lockfile / submodule, `rebase only`, `message`).
  Click = what this version changed; Shift+click = extend the range; "master" = full version.
- **Resume**: a "✓ reviewed" mark on your last review (approval, new comment or "Mark as reviewed"),
  a banner with what moved since, blue dots on the new versions.
- **Diff**: unified or side by side, "seen" files (the tick is dropped if the file changes), files coming from master hidden.
- **Discussions**: threads relocated onto the displayed version ("line modified since"), replies, resolution;
  comment on a line of the latest version.
- **Approve / request changes**, with the version each person approved ("stale" if code changed since).
  An approval that Bitbucket keeps after rebase-only pushes stays valid: nothing to re-approve.

Shortcuts: `j`/`k` file, `n`/`p` thread, `v` seen, `[`/`]` version, `?` help. On AZERTY keyboards, `[` and `]` typed with
Option or AltGr work too.

## Develop

| Command | Role |
|---|---|
| `npm ci` | dependencies from the lockfile |
| `npm run dev` | server in watch mode (port 7420) + Vite with hot reload (port 5173) |
| `npm run dev:fake` | server wired to the fake Bitbucket (no real call); then `npm run dev:web` |
| `npm run check` | lint + types + unit and integration tests (Vitest) |
| `npm run test:e2e` | build then Playwright UI tests on the real server wired to the fake Bitbucket |
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
- **Comment on a line**: only on the latest version (Bitbucket anchors comments on the current version). On a deleted
  line, the tool posts a general comment that quotes the line.
- **Large repositories**: Revspan reads the first 200 open PRs of a repository (4 pages of 50). Beyond that, the home
  page and the VS Code view say the list was cut, and the PRs left out are neither shown nor notified until they come
  into the first 200.
- `npm audit` reports moderate alerts in the lint tooling (minimatch via typescript-eslint, with no fix
  other than a downgrade); nothing in what runs at use time.

## Local data

`~/.config/revspan/` (`%APPDATA%\revspan` on Windows; `REVSPAN_CONFIG_DIR` to change it):
`config.json` (e-mail, repositories, review settings), `state.json` (reviewed versions, seen files, notifications already shown), `home.json` / `home.lock` / `home.drop` (shared home snapshot: PR titles and authors, mode `0600`), `cache/` (immutable contents per commit,
and each PR's activity as the home reads it: user ids, dates, commit hashes, comment ids, no text; can be deleted safely). Several windows (browser tabs, VS Code windows) can share the same folder: the files are
re-read when they change and written atomically, so marks made in one window are not lost in another.

## License

[MIT](LICENSE). Version history: [CHANGELOG.md](CHANGELOG.md).
