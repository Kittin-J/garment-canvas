@AGENTS.md

# Claude Code Collaboration

- Use the `review-and-optimize` skill for repository audits, security/correctness reviews, and evidence-backed fixes.
- Begin every task by recording the current commit, branch, worktree path, and whether the session is read-only or may edit.
- A primary-worktree session is audit-only. Before editing, verify that the current checkout is a linked worktree created for the task; otherwise stop and instruct the user to launch `claude --worktree <task-name>`.
- Start worktrees from the current local `HEAD`. Do not silently switch the baseline to `main` or another remote branch.
- Keep all changes local. Do not push, open pull requests, merge, rebase, cherry-pick, reset hard, or clean.
- Finish with the structured Claude-to-Codex handoff required by `AGENTS.md`.
