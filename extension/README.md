# Revspan for Bitbucket

Review a Bitbucket Cloud pull request **version by version**, right inside VS Code.

When an author amends, rebases and force-pushes on every round of feedback, Bitbucket only shows the full diff against
the target branch. Revspan finds every pushed version of the PR and shows what the author really changed between two
versions, without the noise brought in by rebases.

## Features

- **Review queue** in the "My PRs" view in the activity bar, in four groups: **To do** (PRs needing your review or
  your attention), **My PRs**, **Waiting on the author** (you approved, or your approval still holds after rebase-only
  pushes) and **Other open PRs**. A PR needs review while it has fewer approvals than the minimum (2 by default),
  counted like Bitbucket's merge rule, your approval included. Where you are a designated reviewer, the PR stays in
  "To do" until you approve it.
- **Followed contributors**: follow an author from a PR row to see their PRs first and be notified of new ones.
- **Notifications** for a new PR needing review, a new code version on a PR you reviewed, and (optionally) a failed
  build on your PRs. See "Notifications" below.
- **Build status** from any CI that publishes statuses to Bitbucket: a badge on the cards and in the PR header, and a
  "Builds" tab.
- **Needs rebase** flag on your own PRs when the destination branch moved.
- **Grouping** of "To do" and "Other open PRs" by repository, contributor or not at all (the choice is remembered
  separately for the view and for the page).
- **Version timeline**: one dot per push, rebases detected, with a summary of each version (code, dependencies only,
  rebase only, message only).
- **Comparison of any two versions**, or of a version with its base, with the rebase noise removed.
- **Review resume**: last reviewed version, new versions and new comments since, files already seen.
- **Comments**: threads placed on the displayed version, replies, resolution, new comments on a line of the latest
  version.
- **Approve or request changes**, showing which version each person approved.
- **Open file**: opens the file from the repository cloned in your workspace, at the line. The clone is found by its
  Bitbucket remote, then by folder name. A git worktree checked out on the PR's branch is preferred.
- **VS Code diff**: opens a file's comparison in the native diff editor, with syntax highlighting.

## Requirements

- A **Bitbucket Cloud** account (bitbucket.org).
- Your Atlassian e-mail and an **API token with scopes**, created at
  https://id.atlassian.com/manage-profile/security/api-tokens ("Create API token with scopes", Bitbucket app), with
  these scopes: `read:user:bitbucket`, `read:repository:bitbucket`, `read:pullrequest:bitbucket` and
  `write:pullrequest:bitbucket`.

## Getting started

1. Click the Revspan icon in the activity bar, then **Set up the token** (or run
   **Revspan: Settings (token, repositories)**).
2. In ⚙ Settings, enter your Atlassian e-mail and the token, then click "Test connection".
3. List the repositories to follow, one `workspace/repository` per line.
4. Pick a PR in "My PRs", or run **Revspan: Open a PR (URL)** and paste a pull request URL.

## Commands

| Command | What it does |
|---|---|
| Revspan: Open Home | Shows the "My PRs" home page in a panel. |
| Revspan: Open a PR (URL) | Opens a pull request from its Bitbucket URL. |
| Revspan: Settings (token, repositories) | Opens the settings page: e-mail, token, followed repositories. |
| Revspan: Refresh | Reloads the "My PRs" view. |

## Settings

| Setting | Default | What it does |
|---|---|---|
| `revspan.repositories` | `[]` | Repositories whose open PRs appear, one `workspace/repository` (or the URL) per entry. Editable here or from the panel's Settings; follows Settings Sync and is per profile. |
| `revspan.review.requiredApprovals` | `2` | Approvals a PR needs to leave your "To do" queue. |
| `revspan.review.requiredApprovalsByRepository` | `{}` | Override per repository, for example `{ "acme/records-api": 1 }`. |
| `revspan.review.followedContributors` | `[]` | Followed authors, managed from a PR row. |
| `revspan.notifications.newPullRequest` | `true` | Notify a new PR needing review. |
| `revspan.notifications.newVersion` | `true` | Notify a new code version on a PR you reviewed. |
| `revspan.notifications.buildFailed` | `false` | Notify a failed build on your PRs. |
| `revspan.refreshIntervalMinutes` | `5` | Background refresh interval, in minutes. |

The repositories, per-repository minimum and followed contributors are restricted settings: an untrusted workspace
cannot change them.

## Notifications

- **New PR needing review**: opened by a followed contributor, or you are a designated reviewer.
- **New version**: code or dependencies changed on a PR you reviewed or approved. Rebase-only pushes never notify.
- **Build failed**: one of your own PRs has a failing build (off by default).

Revspan raises one notification per PR and commit, even with several VS Code windows. Nothing is shown on first run, and
switching an option on does not replay the backlog. At most 3 notifications are shown at a time, followed by a summary.
The background refresh starts with VS Code and is skipped while all notifications are off and neither the view nor the
panel is visible.

## Build status and rebase

Revspan reads the statuses Bitbucket shows on the PR, whatever CI publishes them. Two trade-offs: a re-run on the same
commit shows when you open the PR page, and a CI that posts its first status more than 1 hour after the push is shown
as "no build" on the home view for that commit. "Needs rebase" compares the destination branch head, read once per
repository and refresh interval, with the PR's base.

## Language

The interface follows VS Code's display language: French if it starts with `fr`, English otherwise. The PR page shown in
the panel uses the same language.

## Privacy

- Revspan sends **no telemetry**.
- Network traffic goes only to the Bitbucket API, plus the images embedded in PR comments, which are loaded from where
  Bitbucket hosts them. Revspan never calls a CI service.
- A **background refresh** runs from VS Code startup, every `revspan.refreshIntervalMinutes` minutes, to keep the view
  and the notifications up to date. It makes no request while all notifications are off and neither the view nor the
  panel is visible.
- Notifications are **local** VS Code messages. Nothing is sent anywhere to produce them.
- Your API token is stored in VS Code's **SecretStorage**. SecretStorage is shared across VS Code profiles, so the token
  is the same in every profile, while `revspan.repositories` is per profile. The token is never sent to the PR page
  shown in the panel.
- Local data lives in the extension's storage on your machine: reviewed versions, seen files, cached commit contents,
  the notifications already shown, and `home.json`, the last computed home, shared by your windows. `home.json` holds PR
  titles and author names and is written with file mode 0600.

## Limits

- Bitbucket Cloud only. Bitbucket Server and Data Center are not supported.
- Bitbucket eventually deletes the commits overwritten by a force-push. These versions stay in the timeline, marked
  "unavailable", and cannot be compared.
- Comments can only be added on a line of the latest version.
- "Open file" needs a repository cloned on disk, so it is unavailable in virtual workspaces. In an untrusted workspace,
  the list of repositories defined by the workspace is ignored.
