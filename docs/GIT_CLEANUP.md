# Git: stop tracking removed files / undo commits

Run these from the repo root (`Launchpad-eval/`).

## 1. Remove deleted files from Git (still in last commit)

If you already committed files that are now deleted on disk:

```bash
git add -A
git status   # should show deletions staged
git commit -m "chore: drop dev artifacts, pipeline outputs, test stub"
```

## 2. Uncommit the last commit (keep your file changes)

Undo the commit but **keep all edits** in your working tree (unstaged):

```bash
git reset HEAD~1
```

Undo the last commit and **keep changes staged**:

```bash
git reset --soft HEAD~1
```

**Warning:** If you already **pushed** that commit, don’t reset—use `git revert HEAD` instead, or coordinate a force-push.

## 3. Stop tracking a file but keep it locally

```bash
git rm --cached path/to/file
git commit -m "stop tracking file"
```

## 4. Remove files from entire Git history (optional, advanced)

Only if secrets or large junk were committed and must disappear from history:

```bash
# Example: remove all pipeline CSVs from every commit
git filter-repo --path backend/scripts/ --invert-paths
# (install: pip install git-filter-repo)
```

Or use [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/). Then **force-push** and warn collaborators.
