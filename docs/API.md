# Revspan — local API

The contract (request and response types) is defined once, in TypeScript, in
[`src/shared/api.ts`](../src/shared/api.ts): the server and the page both import it.
Inputs are validated on the server by zod ([`src/server/http/schemas.ts`](../src/server/http/schemas.ts)).

Common rules:

- all routes are under `/api`, in JSON;
- any request other than GET carries the `X-Revspan: 1` header (otherwise 403); a foreign origin is rejected;
- the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`;
- error: status other than 2xx and body `ApiErrorBody` = `{ error: { code, message, params? } }`:
  - `code` is stable (`ErrorCode`): `NO_TOKEN` (409), `BB_UNAUTHORIZED` (401), `BB_FORBIDDEN` (403), `BB_NOT_FOUND` (404),
    `BB_UNREACHABLE`, `BB_ERROR`, `BAD_REQUEST` (400), `VERSION_UNAVAILABLE` (410), `FORBIDDEN`, `NOT_FOUND`, `INTERNAL`;
  - `message` is always in English (it is also what shows in the terminal and in logs);
  - `params` (`ErrorParams`) holds the values a client needs to translate the message itself, so the server never sends
    translated text: `reason` (`invalid-email`, `email-required`, `profile-unreadable`, `no-versions`), `path`
    (Bitbucket API path), `status` (Bitbucket's HTTP status), `detail` (Bitbucket's or the system's own text, shown as is)
    and `version` (the version concerned by `VERSION_UNAVAILABLE`). Which parameters appear depends on the code;
  - a client that does not know a code, or that lacks the parameters of its translation, shows `message` as is;
- `GET /api/home` reports repositories it could not read in `errors`, with the same fields (`repo`, `code`, `message`,
  `params`); the other repositories are still listed.

| Method | Route | Body | Response |
|---|---|---|---|
| GET | `/api/health` | — | `Health` |
| GET | `/api/settings` | — | `Settings` |
| GET | `/api/settings/followed` | — | `FollowedList` (local; the pages read it before a follow, since a read of `/api/settings` retitles the VS Code panel) |
| PUT | `/api/settings` | `SettingsUpdate` | `Settings` |
| POST | `/api/settings/test` | — | `ConnectionTest` |
| GET | `/api/home[?fresh=1]` | — | `Home` (`groups`: ordered `{ key, prs }`, no title: each UI translates the key; see "Review queue contract"). `fresh=1` (the Refresh button) skips the home shared by the windows and re-reads live data |
| GET | `/api/pr/:ws/:repo/:id` | — | `PrDetail` (a version whose commit Bitbucket erased has `available: false`; `build`: `[]` no build, `null` statuses unreadable) |
| GET | `/api/pr/:ws/:repo/:id/summary` | — | `Summary` (slow the first time, then disk cache; an unavailable version has kind `unavailable`, the next one has `since`) |
| GET | `/api/pr/:ws/:repo/:id/compare?from=&to=&context=` | — | `Comparison` (`from=0`: full version against its base; 410 `VERSION_UNAVAILABLE` if a bound is unavailable) |
| POST | `/api/pr/:ws/:repo/:id/comments` | `NewComment` | `Comment` |
| DELETE | `/api/pr/:ws/:repo/:id/comments/:cid` | — | `Ok` |
| POST / DELETE | `/api/pr/:ws/:repo/:id/comments/:cid/resolve` | — | `Ok` |
| POST / DELETE | `/api/pr/:ws/:repo/:id/approve` | — | `Ok` (POST re-approves if needed) |
| POST / DELETE | `/api/pr/:ws/:repo/:id/request-changes` | — | `Ok` |
| POST | `/api/pr/:ws/:repo/:id/reviewed` | `{ version }` | `Ok` (local "reviewed" mark) |
| POST | `/api/pr/:ws/:repo/:id/viewed` | `ViewedRequest` | `Ok` |

## Review queue contract

- `PrCard` (in `Home`) gained: `approvals` (participants other than the author, the user included), `requiredApprovals`
  (minimum for the PR's repository), `myApproval`, `newComments`, `needsReview` (`approvals < requiredApprovals`),
  `designatedReviewer`, `followed`, `approvalHolds`, `build: BuildSummary | null` (`state` is `failed`, `running`,
  `success` or `none`, with counts), `needsRebase: boolean | null` (own open PRs only, `null` when not computed), `head`
  (source head commit, 12 characters, `''` if Bitbucket gave none; it is what lets a notification fire once per PR and
  head) and `draft` (Bitbucket draft PR: never `to-do`, never notified).
- `Home.truncated: { repo, count }[]`: repositories with more open PRs than Revspan reads (200); only the first `count`
  are listed.
- `HomeGroupKey` is `'to-do' | 'mine' | 'waiting' | 'others'`, in that order in `Home.groups`. `HomeGroup` is
  `{ key, prs }`, with no title: the page and the VS Code tree each translate the key. The old keys `to-review`,
  `rebase-only` and `up-to-date` are gone.
- `PrDetail.build: BuildCheck[] | null`: the checks of the head commit (`key`, `name`, `state` of `success`, `failed`,
  `running` or `stopped`, `url`, `updatedOn`). `[]` means no build is attached, `null` means the statuses could not be
  read. `PrDetail.needsRebase: boolean | null` follows the same rule as the card.
- `Settings.review: ReviewSettings` (`requiredApprovals`, `requiredApprovalsByRepo`, `followed`, `notifications`,
  `refreshMinutes`). `PUT /api/settings` accepts a partial `review`, merged into the current values (notifications key
  by key); an invalid value is replaced by its default.
- `GET /api/settings/followed` returns `FollowedList` (`{ followed }`), read from the local configuration with no
  Bitbucket call. It exists because the pages need the current list before a follow or an unfollow, and reading
  `/api/settings` has a side effect in VS Code (it retitles the panel).

Page: Vue SPA served from `dist/web`, hash routing (`#/`, `#/pr/:ws/:repo/:id?from=&to=`, `#/settings`).
`GET /open?url=<Bitbucket PR URL>` redirects to `/#/pr/...`.

In the VS Code extension the same routes are served in memory: the page posts `request` messages
([`src/shared/webview-protocol.ts`](../src/shared/webview-protocol.ts)) and the extension hands them to the same Hono
application (`app.request`, no open port), with the same validation and the same errors. Messages are validated
before use; see the "Webview messages" row of [DESIGN.md](DESIGN.md).
