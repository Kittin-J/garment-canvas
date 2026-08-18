import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hookPath = join(repoRoot, ".claude/hooks/require-linked-worktree.mjs");

function gitPath(flag) {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", flag], {
    encoding: "utf8",
  }).trim();
}

function runHook(cwd, toolName, toolInput) {
  return spawnSync(process.execPath, [hookPath], {
    cwd: repoRoot,
    encoding: "utf8",
    input: JSON.stringify({ cwd, tool_name: toolName, tool_input: toolInput }),
  });
}

function expectExit(label, result, expected) {
  assert.equal(result.status, expected, `${label}: ${result.stderr || result.stdout}`);
}

const commonGitDir = gitPath("--git-common-dir");
const currentGitDir = gitPath("--git-dir");
const primaryRoot = dirname(commonGitDir);

const primaryWrite = runHook(primaryRoot, "Write", { file_path: join(primaryRoot, "blocked.txt") });
expectExit("primary Write", primaryWrite, 2);
assert.doesNotMatch(primaryWrite.stderr, /^\s*\{/, "exit-2 denial should be a readable plain-text reason");
expectExit("Read .env", runHook(primaryRoot, "Read", { file_path: join(primaryRoot, ".env") }), 2);
expectExit(
  "Read public .env.example",
  runHook(primaryRoot, "Read", { file_path: join(primaryRoot, ".env.example") }),
  0,
);
expectExit(
  "Read private .env.example.local",
  runHook(primaryRoot, "Read", { file_path: join(primaryRoot, ".env.example.local") }),
  2,
);
expectExit("Grep .env", runHook(primaryRoot, "Grep", { path: ".env", pattern: "KEY" }), 2);
expectExit("Glob .env", runHook(primaryRoot, "Glob", { path: ".", pattern: "**/.env*" }), 2);
expectExit(
  "primary NotebookEdit",
  runHook(primaryRoot, "NotebookEdit", { notebook_path: join(primaryRoot, "blocked.ipynb") }),
  2,
);
expectExit("ordinary Read", runHook(primaryRoot, "Read", { file_path: join(primaryRoot, "AGENTS.md") }), 0);
expectExit("ordinary Grep", runHook(primaryRoot, "Grep", { path: "src", pattern: "canvas" }), 0);
expectExit("ordinary Glob", runHook(primaryRoot, "Glob", { path: "src", pattern: "**/*.ts" }), 0);
expectExit("read-only git", runHook(primaryRoot, "Bash", { command: "git status --short" }), 0);
expectExit("sed write command", runHook(primaryRoot, "Bash", { command: "sed -n '1w /tmp/x' AGENTS.md" }), 2);
expectExit("secret glob", runHook(primaryRoot, "Bash", { command: "cat *.env" }), 2);
expectExit("variable expansion", runHook(primaryRoot, "Bash", { command: "p=push; git $p origin main" }), 2);

if (currentGitDir !== commonGitDir) {
  expectExit(
    "linked in-root Write",
    runHook(repoRoot, "Write", { file_path: join(repoRoot, "tmp/allowed.txt") }),
    0,
  );
  expectExit(
    "linked Write into primary",
    runHook(repoRoot, "Write", { file_path: join(primaryRoot, "blocked-from-linked.txt") }),
    2,
  );

  const insideRoot = join(repoRoot, "tmp", `guardrail-hook-${process.pid}`);
  const outsideRoot = mkdtempSync(join(tmpdir(), "guardrail-hook-outside-"));
  mkdirSync(insideRoot, { recursive: true });
  symlinkSync(outsideRoot, join(insideRoot, "escape"));
  try {
    expectExit(
      "linked Write through escaping symlink",
      runHook(repoRoot, "Write", { file_path: join(insideRoot, "escape", "blocked.txt") }),
      2,
    );
  } finally {
    rmSync(insideRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

console.log("Claude guardrail hook tests passed");
