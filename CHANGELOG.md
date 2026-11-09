# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- VS Code extension: tracked repositories in the `revspan.repositories` setting (VS Code Settings, Settings Sync, per
  profile), still editable from the panel's ⚙ Settings.
- VS Code extension: works in an untrusted workspace; in a virtual workspace, everything except "Open file".
- MIT license, icon, GitHub Actions CI (lint, types, tests, UI tests, `.vsix`) and GitHub release on a `v*` tag.
- Loading indicator on action buttons (approve, request changes, mark reviewed, comment,
  reply, resolve, delete, save, test, refresh); only one write at a time.
- "My PRs" (page and VS Code view): the PR's repository and number before its title.

### Changed

- The project is now called Revspan ("Revspan for Bitbucket" in VS Code), with a new logo: extension
  `theodoreguillet.revspan`, setting `revspan.repositories`, `REVSPAN_*` variables, configuration `~/.config/revspan`,
  keychain `revspan-bitbucket`, command `revspan`. Nothing is carried over automatically from Strata: in VS Code,
  enter the token again in ⚙ Settings.

### Fixed

- A PR with an old version erased by Bitbucket (commit overwritten by a force-push) no longer opened
  ("Not found on Bitbucket: …/commit/…"). These versions are now shown as "unavailable" in the timeline.
- An approval that Bitbucket keeps after rebase-only pushes is no longer presented as needing to be redone: "Remove
  approval" instead of "Re-approve", banner "Mark vN as reviewed", PR "Up to date" on the home page.

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
