# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [3.2.1] - 2026-11-12

### Changed

- PRs are sorted by date everywhere in "My PRs" (page and VS Code view): newest push first inside each group, and
  repository or contributor subgroups ordered by their most recent PR instead of by name. Followed contributors no
  longer jump to the top; the groups themselves keep their order.

## [3.2.0] - 2026-11-10

### Added

- "To rebase" group (« À rebaser »): your open PRs whose destination branch moved since their base leave "My PRs" and
  are listed right after "To review", on the home page and in the VS Code view. Build checks, the Refresh recheck and
  the failed-build notification cover them like any of your PRs.
- Hide the PRs of contributors you do not follow (`revspan.review.hideUnfollowed`, on by default; `review.hideUnfollowed`
  in the browser version). Your own PRs, the PRs where you are a designated reviewer and the ones you reviewed or
  approved always stay, and nothing is hidden while you follow nobody. The home page and the VS Code view show how many
  PRs are hidden, with a link to the settings. Notifications are unchanged, and switching the setting costs no Bitbucket request.
- Follow a contributor from Settings: under "Followed contributors", pick one of the authors of the open PRs in your
  repositories and click **Add**.

### Changed

- "To do" is now "To review" (« À relire »). Once you follow at least one contributor, it lists only the PRs of
  followed authors, the ones where you are a designated reviewer and the ones you reviewed or approved whose code
  changed since; other PRs needing review go to "Other open PRs". While you follow nobody, every PR needing review is
  still listed.
- Saving a setting VS Code does not know yet (the extension was updated but the window was not reloaded) now asks you
  to reload the window instead of showing an internal error, and saves none of the other changes. Saving or following
  without touching the new setting keeps working until the reload.
- French texts of the review, notification and settings strings now say « tu » everywhere.

## [3.1.0] - 2026-11-10

### Added

- Review queue: the home page and the VS Code view now show what waits for you. A PR needs review while it has fewer
  approvals than the minimum (2 by default, `revspan.review.requiredApprovals`, with an override per repository in
  `revspan.review.requiredApprovalsByRepository`). Approvals are counted the way Bitbucket counts them for the merge
  rule: every participant except the author, you included. An invalid minimum (0, negative, not a whole number) falls
  back to the default instead of hiding or flooding the queue. With a token that cannot read your profile (no
  `read:user:bitbucket`), every PR lands in "Other open PRs", no notification is sent, and the page says why.
- Four home groups: "To do", "My PRs", "Waiting on the author" and "Other open PRs". A PR where you are a designated
  reviewer stays in "To do" until you approve it, or until you request changes and only neutral pushes follow (it then
  waits on the author).
- Draft PRs: they go to "Other open PRs" with a "draft" badge, never to "To do", and never notify (your own drafts stay
  in "My PRs"). Once ready for review, a draft is treated like a new PR.
- Followed contributors (`revspan.review.followedContributors`): follow an author from a PR row; their PRs are listed
  first and can raise a notification.
- Grouping of "To do" and "Other open PRs" by repository, by contributor or not at all, chosen separately on the page
  and in the VS Code view.
- VS Code notifications, each behind its own setting: a PR needing review from a followed contributor or from someone
  who designated you (on by default), a new version of code or dependencies on a PR you reviewed or approved (on by
  default), a failed build on one of your PRs (off by default). One notification per PR and commit, even with several
  windows; none on first run or when you switch an option on; rebase-only pushes never notify; at most 3 notifications
  at a time, then a summary.
- Background refresh in VS Code, every `revspan.refreshIntervalMinutes` minutes (5 by default), started when VS Code
  starts. It does nothing while all notifications are off and neither the view nor the panel is visible. Like the
  repositories, the refresh interval and the notification options are ignored when set by an untrusted workspace.
- Build status from any CI that publishes statuses to Bitbucket: a badge on the home cards and in the PR header, and a
  "Builds" tab on the PR page with each check and its link. The checks are read again during the hour after a push, so
  a CI that starts after another one finished (lint first, then the tests) is not missed. A re-run on the same commit
  later than that shows on the PR page, or with Refresh for your own PRs.
- "Needs rebase" flag on your own open PRs when the destination branch moved since the PR's base.
- A notice on the home page and in the VS Code view when a repository has more open PRs than Revspan reads (the first
  200 are listed).

### Changed

- The home groups "To review", "Quick re-approval" and "Up to date" are replaced by the four groups above. A PR whose
  approval Bitbucket kept after rebase-only pushes goes to "Waiting on the author".
- The approval count of a card now includes your own approval, as Bitbucket's merge rule does.
- Several windows share one computed home (`home.json`, `home.lock` and `home.drop` in the configuration folder, file
  mode `0600`), and the refresh is much lighter on Bitbucket: a steady state costs about 3 requests per cycle instead
  of 30. With several windows, a new push can show up after up to about 1.5 intervals. A write from Revspan (approve,
  comment) drops the shared home, so it shows at once, and Refresh (the VS Code command or the page's "↻ Refresh"
  button) reads Bitbucket again instead of the shared home.
- Saving the settings no longer resets the session unless the e-mail or the token changed.
- Marketplace README and privacy section updated (background refresh, local notifications, local data).

## [3.0.0] - 2026-11-09

### Added

- VS Code extension: tracked repositories in the `revspan.repositories` setting (VS Code Settings, Settings Sync, per
  profile), still editable from the panel's ⚙ Settings.
- VS Code extension: works in an untrusted workspace; in a virtual workspace, everything except "Open file".
- MIT license, icon, GitHub Actions CI (lint, types, tests, UI tests, `.vsix`) and GitHub release on a `v*` tag.
- Loading indicator on action buttons (approve, request changes, mark reviewed, comment,
  reply, resolve, delete, save, test, refresh); only one write at a time.
- "My PRs" (page and VS Code view): the PR's repository and number before its title.
- The interface is available in French and English. The VS Code extension follows VS Code's display language (French
  for `fr*`, English otherwise), the browser page follows the browser's language.
- VS Code extension: the Revspan panel is reopened on its page after "Reload Window", and its title follows the page
  shown.
- VS Code extension: "Open file" finds the local clone by its Bitbucket remote (https or ssh), including git worktrees of
  bare repositories.
- Marketplace README for the extension.

### Changed

- The project is now called Revspan ("Revspan for Bitbucket" in VS Code), with a new logo: extension
  `theodoreguillet.revspan`, setting `revspan.repositories`, `REVSPAN_*` variables, configuration `~/.config/revspan`,
  keychain `revspan-bitbucket`, command `revspan`. Nothing is carried over automatically from Strata: in VS Code,
  enter the token again in ⚙ Settings.
- Code comments, tests and documentation are now in English; only the French translation catalogs remain in French.

### Fixed

- A PR with an old version erased by Bitbucket (commit overwritten by a force-push) no longer opened
  ("Not found on Bitbucket: …/commit/…"). These versions are now shown as "unavailable" in the timeline.
- An approval that Bitbucket keeps after rebase-only pushes is no longer presented as needing to be redone: "Remove
  approval" instead of "Re-approve", banner "Mark vN as reviewed", PR "Up to date" on the home page.
- A version purged by Bitbucket after Revspan cached it is now shown as "unavailable" instead of failing the whole page.
- Comparing a binary or very large file across a rebase no longer drops it or reports a false change.
- Bitbucket client: write requests (approve, comment, ...) are no longer retried after a server error, which could post
  twice; unparsable responses and redirects to another host are handled safely (the token is never sent elsewhere).
- File paths with `.` or `..` segments are refused. In VS Code, "Open file" cannot leave the repository, and malformed
  messages from the page are ignored.
- Marks and settings saved in one window (browser tab or VS Code window) are no longer overwritten by another window.
- A new version pushed while a PR is open now refreshes the summary, the banner and the approval state on reload.
- `[` and `]` shortcuts work on AZERTY keyboards (Option or AltGr).
- Keyboard access: Space and Enter on file rows and versions, focus kept inside the shortcuts dialog.
- "Delete token" no longer erases the unsaved e-mail and repositories in the settings; undoing a failed "Seen" no longer
  reverts other files; a reload no longer shows a stale comparison.
- VS Code extension: `revspan.repositories` is saved at the level that defines it (user or workspace), and
  closing a panel releases its listeners.

## [2.0.0] - 2026-11-06

First version published under the name Strata.

### Added

- Version timeline of a Bitbucket PR (one dot per push, rebases detected), comparison of any two versions
  or of a version with its base, without the noise brought in by rebases (version replayed onto the new base).
- Summary of each version: code, dependencies only, rebase only, message only.
- Review resume: last reviewed version, new versions and new comments, seen files.
- Discussions relocated onto the displayed version; comment, reply, resolve, approve, request changes.
- "My PRs" home page over the tracked repositories.
- Token in the macOS keychain, `secret-tool` on Linux, otherwise a `0600` file.
- VS Code extension: "My PRs" view, PR page in a panel, "Open file" (git worktree of the PR's branch
  preferred) and native "VS Code diff".
