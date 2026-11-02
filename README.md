# Source Studio

A lazygit-style source control panel for VS Code: multi-repository status, keyboard-driven
staging, and (coming) branches, worktrees, stashes, and a commit graph.

## Phase 1 (this scaffold)

- **Repositories** view: every git repo found in the workspace (each workspace folder, the
  enclosing repo if you opened a subfolder, and subfolders up to `sourcestudio.scanDepth` deep).
  Click a repo to make it *active*; the other views scope to it.
- **Files** view: Conflicts / Staged / Changes / Untracked, nested by folder, with checkboxes
  to stage and unstage. Click a file to open its diff; use *Open Diff* on a folder to open a
  multi-diff of everything under it.
- Status bar item showing the active repo and branch (`main ↑2 ↓1 ●5`); click to switch.
- Auto-refresh via file watchers on the worktree and `.git` internals.

## Keymap (while a Source Studio view has focus)

| Key | Action |
|---|---|
| `space` | Stage / unstage selection |
| `a` | Stage all |
| `d` | Discard selection |
| `c` | Commit |
| `P` / `p` / `f` | Push / Pull / Fetch |
| `R` | Refresh |
| `1` / `2` | Focus Repositories / Files |
| `?` | Show keymap |

## Development

```sh
npm install
npm run watch        # esbuild in watch mode
# then F5 in VS Code → "Run Extension"
npm run typecheck    # tsc --noEmit
npm run package      # builds a .vsix
```

## Layout

```
src/
  extension.ts            activation, wiring
  git/exec.ts             spawn git, GitError
  git/repository.ts       GitRepository: status parsing + actions
  git/discovery.ts        find repos in the workspace
  git/types.ts            FileStatus / RepoStatus
  model/repoManager.ts    registry, active repo, watchers
  diff/gitContentProvider.ts   sourcestudio-git: scheme for HEAD/index contents
  diff/openDiff.ts        vscode.diff / vscode.changes helpers
  views/reposView.ts      Repositories tree
  views/filesView.ts      Files tree (checkbox staging)
  commands/index.ts       all commands
  statusBar.ts
```

## Roadmap

1. ✅ Scaffold, git layer, Repos + Files, diffs, status bar
2. Branches / Worktrees / Stashes views, undo (reflog)
3. Commit graph webview
4. Interactive rebase, hunk staging, custom commands, conflict flow
