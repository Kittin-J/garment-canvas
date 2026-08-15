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

# Garment Canvas — Shared Project Rules

## Project Baseline

- Use Node.js 20.9 or newer. The application is TypeScript with React 19, Vite 6, Express 4, and PostgreSQL 18.
- Treat PostgreSQL as the production source of truth. SQLite support exists only for legacy import and migration verification.
- Use the existing npm scripts: `npm run lint` for type-checking, `npm run test` for the isolated PostgreSQL regression suite, `npm run check` for both, and `npm run build` for production bundles.
- Keep generated output, runtime data, private `.env`/`.env.local` files, secrets, uploads, database dumps, and credentials out of commits and agent output. The tracked `.env.example` remains the public configuration contract.

## Security and Data Invariants

- Keep `/api/health`, `/api/ready`, login, and session-check behavior intentionally separated from authenticated application routes. Do not weaken `requireAuth`, `requirePasswordChanged`, or `requireAdmin` coverage.
- Preserve one active device session per account, hashed session tokens, replacement-session reporting, secure cookie attributes, and session revocation after password, account, or administrator changes.
- Enforce owner/admin checks on projects, files, assets, history, usage, and generated output. For cross-resource lookups, prefer a non-disclosing `404` when revealing existence would leak private data.
- Validate image identifiers, MIME/extension, decoded size, and local image references before filesystem access. Prevent path traversal and never expose arbitrary local or remote URLs.
- Keep multi-table ownership transfers, destructive account actions, session replacement, and reference updates transactional. Preserve the 15-day recovery behavior and referenced-asset deletion guards.
- Never expose AI gateway keys to the client or logs. Require HTTPS gateway configuration, retain request limits and reference-image ordering, and do not call paid providers from automated tests.
- Preserve workflow schema compatibility, node/edge migration behavior, the maximum of eight ordered reference images, and non-stretching output resize semantics.

## Change Workflow

- Inspect the relevant execution flow and tests before proposing a change. Use GitNexus `impact` before editing a function, class, method, route contract, or shared type.
- Prefer the smallest evidence-backed patch. Do not combine security/correctness fixes with cosmetic cleanup, broad rewrites, dependency upgrades, or unrelated formatting.
- Add or update regression coverage for every behavior change. Tests must demonstrate the failure before the fix when practical.
- For auth, authorization, storage, migration, provider, workflow, or API-contract changes, run the matching focused test file before the full suite.
- Before handoff, run `npm run check`, `npm run build`, and GitNexus `detect_changes`. Report any unavailable test or degraded graph result explicitly.

## Git and Agent Collaboration

- Claude may edit only inside a linked worktree created for its task. A read-only audit may run in the primary worktree, but it must not change files there.
- Claude may create local commits on its worktree branch. It must never push, create a PR, merge, rebase, cherry-pick, force-reset, or clean the repository.
- Codex reviews `BASE_COMMIT..CLAUDE_COMMIT`, reruns impact analysis and tests, and decides whether to adopt, rewrite, or reject each change. Never cherry-pick a Claude commit without reviewing its diff and evidence.
- Every Claude handoff must include `BASE_COMMIT`, worktree path, branch, commit IDs, findings, tests run, affected flows, residual risks, and requested Codex review focus.
- Refresh stale GitNexus data with `node .gitnexus/run.cjs analyze --index-only --pdg`; keep `--index-only` so generated context does not overwrite these shared rules.
