# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [3.4.0] - 2026-11-17

### Added

- ↻ Refresh on the PR page: reads the PR again (comments, approvals, versions) and says what came in ("1 new version ·
  2 new comments", "Updated", "Up to date"). The shown diff stays unless its range changed or a new thread lacks its
  place.
- Periodic check for news while a PR page is visible: one light read of the PR at the refresh interval of the settings
  (`revspan.refreshIntervalMinutes`, `review.refreshMinutes` in the browser version), none for a hidden tab. News shows
  a banner with a Refresh button; the page never changes by itself.
- Edit your own comments. Reopen a resolved thread from its folded bar.
- Search the diff (`/`): file names and the lines shown (or whole files), with a match count per file and Enter /
  Shift+Enter to move across matches.
- Search PRs on the home page (`/` to focus, Esc to clear): by title, `#number`, repository or author, ignoring case and
  accents. Groups without a match are hidden and the counts show the matches.
- Mark all viewed (button of the file list or `Shift+V`): every listed file in one request.
- Tasks tab: the PR's Bitbucket tasks, read when the tab is opened; add, tick, reopen and delete tasks, with the open
  count on the tab (only your own tasks can be deleted).
- Approval count in the PR header, left of the reviewers: "1/2 approvals" (Bitbucket approvals other than the author's
  against the required count of the repository), green once met, following your approval at once.
- Rebase and merge-conflict chips in the PR header for any open PR: "Needs rebase on master" when the destination moved
  since the PR's base, "⚠ Conflicts with master · N files" when Bitbucket reports merge conflicts (a click opens the
  first conflicting file, marked in the file list).
- Syntax highlighting with the VS Code Dark+ / Light+ themes for the common languages.
- Timeline legend and a short two-line version tooltip.
- VS Code: each PR opens in its own editor tab (the home page and settings share the "Revspan" tab); opening a PR that
  already has a tab shows it, and Reload Window restores every tab without duplicates. The "My PRs" view shows when it
  is loading.

### Changed

- Timeline legend: no entry for unavailable versions any more, the timeline already says "unavailable" under them.
- Timeline: clicking the selected version again compares the whole version with master (a third click goes back to
  what it changed), without leaving the timeline.
- Writes show at once: a comment, a reply, a resolution, an edit, a deletion, an approval, a change request, "Mark as
  reviewed" and task changes appear before Bitbucket answers (put back with the error if it refuses), then a background
  read confirms them. The review buttons then act on the new state.
- Loading is visible: a range not computed yet keeps the current diff with a progress bar, then shows placeholder files
  after 200 ms.
- The diff toolbar stays under the timeline while scrolling.
- Added and removed files are always shown unified, even in side-by-side view.
- Changed lines mark only the words that changed, each change as one light band even across several syntax colors; a
  removed line is compared with the most similar added line around it (side by side, the two share a row), words added
  to or removed from a line are marked however short the line, and lines that differ too much keep only the line
  color.
- Contributor subgroups of the home are sorted alphabetically.
- The "My PRs" view no longer has an "Open a PR (URL)" title button (the home page has the URL field; the command
  stays), and the home page no longer shows the top bar.

### Fixed

- Timeline: after expanding the folded versions of a long PR, a "Fold" button next to the presets folds them again.
- Comments no longer count as a review: only an approval or "Mark as reviewed" sets your last review, so people who
  only commented get no "new" badges and their PRs stay in "To review".
- Requesting changes does not mark the PR reviewed either (the "✓ reviewed" mark stays where it was); the PR still moves
  to "Waiting on the author" until new code arrives.
- Timeline: the blue range bar sits at the same height under every item (versions, gaps, spaces, the reviewed mark and
  folded blocks); it used to be lower under the versions.

### Performance

- Reopening a PR within the refresh interval reads nothing from Bitbucket: the loaded PR and its comparisons are kept
  in memory for that interval (a write, ↻ or a later open reads again).
- The presets (since your review, last version, all) are computed in the background for a PR of up to 30 files, while
  the page is visible, so switching to them is instant.
- Merge conflicts are read only for a PR behind its destination, once per pair of source and destination heads; the
  page waits at most 5 s for them (no retry), and a slower answer only leaves the chip out.
- Task writes are confirmed by one light read (the open count) instead of a full reload of the PR.
- The notifier's version check reuses the activity the home just read instead of reading it again.
- A new version keeps the cached comparisons whose versions did not change.
- Opening a local file from VS Code reads nothing while the PR is loaded.
- Large diffs render progressively, without blocking the page.

## [3.3.0] - 2026-11-12

### Added

- The file list of the diff can be resized: drag its right edge, like the VS Code sidebar (arrow keys when the edge
  has the focus, double-click for the default width). The width is remembered.

### Changed

- The file list is a folder tree, like the VS Code explorer: folders first, chains of single folders merged
  ("src/server/core"), file names no longer truncated by their folder. A folder collapses with a click and then shows
  its unviewed file count and its threads; moving to one of its files (j/k, scroll) opens it again.
- The diff follows the order of the tree, so j/k and scrolling match the list.

## [3.2.1] - 2026-11-12

### Changed

- PRs are sorted by date everywhere in "My PRs" (page and VS Code view): newest push first inside each group, and
  repository or contributor subgroups ordered by their most recent PR instead of by name. Followed contributors no
  longer jump to the top; the groups themselves keep their order.
- Hovering a PR (page and VS Code view) shows the date of its last push and the date it was opened.

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
