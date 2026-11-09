# Revspan for Bitbucket

Review a Bitbucket Cloud pull request **version by version**, right inside VS Code.

When an author amends, rebases and force-pushes on every round of feedback, Bitbucket only shows the full diff against
the target branch. Revspan finds every pushed version of the PR and shows what the author really changed between two
versions, without the noise brought in by rebases.

## Features

- **"My PRs" view** in the activity bar: your open PRs and the PRs waiting for your review, in the repositories you follow.
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

1. Click the Revspan icon in the activity bar, then **Set up the token** (or run **Revspan: Settings (token, repositories)**).
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

- `revspan.repositories`: the Bitbucket repositories whose open PRs appear in "My PRs", one `workspace/repository` (or
  the repository URL) per entry. It can be edited from VS Code's Settings or from ⚙ Settings in the Revspan panel. It
  follows Settings Sync and is specific to each VS Code profile.

## Language

The interface follows VS Code's display language: French if it starts with `fr`, English otherwise. The PR page shown in
the panel uses the same language.

## Privacy

- Revspan sends **no telemetry**.
- Network traffic goes only to the Bitbucket API, plus the images embedded in PR comments, which are loaded from where
  Bitbucket hosts them.
- Your API token is stored in VS Code's **SecretStorage**. SecretStorage is shared across VS Code profiles, so the token
  is the same in every profile, while `revspan.repositories` is per profile. The token is never sent to the PR page
  shown in the panel.
- Local data (reviewed versions, seen files, cached commit contents) lives in the extension's storage on your machine.

## Limits

- Bitbucket Cloud only. Bitbucket Server and Data Center are not supported.
- Bitbucket eventually deletes the commits overwritten by a force-push. These versions stay in the timeline, marked
  "unavailable", and cannot be compared.
- Comments can only be added on a line of the latest version.
- "Open file" needs a repository cloned on disk, so it is unavailable in virtual workspaces. In an untrusted workspace,
  the list of repositories defined by the workspace is ignored.
