# Changelog

## 1.2.0

- Fetch, Pull and Push toolbar buttons in the Repositories and Branches views

## 1.1.0

GitHub integration.

- Branches view shows each branch's open pull request number, draft state and check status (✓ / ✗ / ●), with PR details on hover
- `o` in Branches opens the branch's pull request, or pushes the branch and opens GitHub's compare page to create one
- Copy Pull Request URL from a branch's context menu
- Open on GitHub for branches, commits (`o` in Commits), files, and the current line or selection in an editor (`alt+g`)
- Copy GitHub URL from the Commits view and editor context menus
- Sign in through VS Code's built-in GitHub account; Sign in to GitHub button in the Branches toolbar when signed out
- GitHub Enterprise Server support via `github-enterprise.uri` or `sourcestudio.github.enterpriseHosts`
- New settings: `sourcestudio.github.enabled`, `sourcestudio.github.remote`, `sourcestudio.github.enterpriseHosts`

## 1.0.0

Initial release.

- Repositories view with multi-repo discovery and an active-repo model
- Files view with folder nesting, checkbox staging, diffs and multi-diffs
- Branches: checkout, create, delete, rename, rebase, merge, fast-forward, upstream
- Worktrees: switch, create, remove, prune
- Stashes: apply, pop, drop, create (all / staged / with untracked)
- Commits graph with cherry-pick, revert, reset, branch-from, copy SHA
- Interactive rebase: squash, fixup, reword, drop, edit, move
- Reflog-based undo/redo and reflog browser
- Hunk and line staging/unstaging/discarding from the diff editor
- Commit panel with templates, branch prefix, amend, no-verify, sign-off
- File and line blame
- lazygit-style keymap across every view
