---
name: review-and-optimize
description: Audit and safely improve Garment Canvas with evidence, GitNexus impact analysis, regression tests, isolated worktree edits, and a structured Claude-to-Codex handoff. Use for project reviews, security or correctness audits, optimization requests, branch reviews, and fixing confirmed findings; default the first pass to authentication, authorization, file and asset access, PostgreSQL migrations and transactions, AI gateway boundaries, and workflow data consistency.
---

# Review and Optimize

Follow the five phases in order. Keep the audit independent from prior conclusions and prefer raw source, graph, test, and diff evidence.

## 1. Establish the baseline

- Record `BASE_COMMIT` with `git rev-parse HEAD`, the current branch, repository root, worktree path, and `git status --short` before doing anything else.
- Determine whether the current checkout is the primary worktree or a linked worktree using `git worktree list --porcelain`.
- Allow a read-only audit in either location. Refuse all edits in the primary worktree and instruct the user to restart with `claude --worktree <task-name>`.
- Stop if unrelated user changes make the audit or patch ambiguous. Do not stash, discard, overwrite, or absorb them.

## 2. Audit before editing

- Read `AGENTS.md` and the GitNexus repository context. If the index is stale, refresh it from the primary checkout with `node .gitnexus/run.cjs analyze --index-only --pdg` or report why refresh is unsafe.
- Use GitNexus `query`, `context`, route/API tools, `pdg_query`, and `explain` before falling back to text search for structural questions.
- Inspect tests and run focused non-mutating checks needed to distinguish real defects from speculation.
- Prioritize authentication and authorization, owner/admin boundaries, file and asset access, PostgreSQL migrations and transactions, AI gateway secrets and limits, workflow persistence, and API contracts.
- Report every finding with: `ID`, `Severity` (`P0`–`P3`), `Confidence`, `File:line`, `Evidence`, `Impact`, `Reproduction or test`, and `Recommended fix`.
- Do not report formatting preferences, hypothetical issues without an executable path, or broad redesign ideas as defects.

## 3. Fix confirmed findings only

- Edit only when the user requested fixes and the session is in a linked worktree.
- Before changing a function, class, method, route contract, or shared type, run GitNexus upstream `impact`. If risk is HIGH or CRITICAL, stop before editing and report the blast radius.
- Implement the smallest coherent fix. Keep unrelated cleanup, dependency upgrades, and cosmetic changes out of the patch.
- Add a regression test that fails on the original behavior when practical.

## 4. Verify the branch

- Run the closest focused test first, then `npm run check` and `npm run build`.
- Run GitNexus `detect_changes` against the current linked worktree and compare the result with the intended scope. Report degraded or stale graph evidence.
- Review `git diff --check`, `git diff --stat`, and the complete diff. Confirm that no private `.env`/`.env.local` files, credentials, runtime data, generated build output, uploads, or unrelated files are included; allow intentional updates to the tracked `.env.example` contract.
- If any required check fails, do not present the change as complete. Either fix it or record the exact blocker and preserve the evidence.

## 5. Commit and hand off

- Create one or more focused local commits only after verification. Never push, create a PR, merge, rebase, cherry-pick, reset hard, or clean.
- End with this exact report structure:

```text
BASE_COMMIT: <sha>
WORKTREE: <absolute path>
CLAUDE_BRANCH: <branch>
CLAUDE_COMMITS: <sha list or NONE>

FINDINGS:
- <ID, severity, confidence, location, evidence, impact>

CHANGES:
- <behavioral change and regression test>

TESTS:
- <command>: PASS | FAIL | NOT RUN — <reason>

GITNEXUS_IMPACT:
- <affected symbols, flows, and risk>

RESIDUAL_RISKS:
- <remaining issue or NONE>

CODEX_REVIEW_FOCUS:
- <specific diff, assumption, or risk to re-check>
```

- Ask Codex to review `BASE_COMMIT..CLAUDE_COMMIT`, rerun impact analysis and tests, and decide whether to adopt, rewrite, or reject the change. Do not recommend blind cherry-picking.
