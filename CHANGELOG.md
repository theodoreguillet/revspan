# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
