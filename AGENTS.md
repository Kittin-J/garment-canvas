<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **garment-canvas** (7300 symbols, 15964 relationships, 208 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user. For unified PDG impact, add `mode: "pdg"` with optional `line: <N>` — it returns statement-level `affectedStatements` over CDG + REACHING_DEF and inter-procedural symbols in `interproceduralByDepth`/`byDepth`; no-layer/degraded PDG results are UNKNOWN-risk notes (`--pdg` layer).
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).
- For control/data dependence, `pdg_query({mode: "controls", target: "fileOrSymbol"})` answers "under what condition does X run?" (CDG, incl. guard clauses) and `pdg_query({mode: "flows", target, variable})` traces "where does variable Y flow?" (REACHING_DEF). `--pdg` layer.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/garment-canvas/context` | Codebase overview, check index freshness |
| `gitnexus://repo/garment-canvas/clusters` | All functional areas |
| `gitnexus://repo/garment-canvas/processes` | All execution flows |
| `gitnexus://repo/garment-canvas/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Codex application-audit handoff (2026-08-18)

- Branch/worktree: `codex/fix-app-review` in `.claude/worktrees/fix-app-review`, based on `main` commit `7859749`.
- Source reviewed: `CODEX_REVIEW_HANDOFF_APP.md`; findings were reproduced against current code rather than applied blindly.
- Confirmed and fixed: G1–G4, G6–G8, A1–A2, A4–A6, D1–D6, F1–F2, F4–F5, F7–F9.
- Key behavior changes:
  - DAG generation records settle once per whole run, aggregate successful provider requests, and clean files from failed runs.
  - SSE consumers require a target-node terminal event, reject stale sequence numbers, and preflight run liveness.
  - Legacy assets are insert-only; existing ownership/scope is never overwritten.
  - Active account IDs use a partial unique index so soft-deleted login names can be reused.
  - Forced-password admins cannot call account-management routes before changing the temporary password.
  - Asset creation validates file access; deletion/reference writes use row locks; deleted listings and history deletion do not leak other users' data.
  - Initial history merges optimistic records, and pagination is pinned to a stable `before` snapshot.
- Deliberately not changed without a product decision:
  - G5: whether legacy direct `/api/generate` callers may request 8 images when typed DAG nodes cap some kinds at 4.
  - A3 retention scope: the purge-deadline reset bug is fixed, but adding 15-day tombstones for `files`, `generation_runs`, and `usage_events` needs a retention/schema decision.
  - F3: backend/runtime already rejects more than 8 actual references; frontend truncation versus connection rejection remains a UX decision.
  - F6: closing a running tab already requires explicit confirmation; cancellation/persistence semantics are product behavior.
  - F10/F11: comparison-limit notification and queued-button wording/disabled presentation are low-risk UX choices, not correctness failures (the store already prevents duplicate runs).
- Validation completed: `npm run check` passed, `npm run build` passed, and GitNexus compare-mode change detection reviewed the expected generation/provider/auth/history/asset flows (overall graph risk: CRITICAL because shared Provider and SSE hubs changed).
