import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireTestLock, createComposeProjectName } from "../scripts/test-with-postgres.mjs";

const first = createComposeProjectName({ cwd: "/tmp/worktree-a" });
const second = createComposeProjectName({ cwd: "/tmp/worktree-b" });
const repeat = createComposeProjectName({ cwd: "/tmp/worktree-a" });

assert.match(first, /^garment-canvas-test-[a-f0-9]{10}$/);
assert.equal(first, repeat, "the same worktree must reuse its Compose project after a crash");
assert.notEqual(first, second, "different worktrees must use different Compose projects");

const lockRoot = join(tmpdir(), `garment-canvas-lock-test-${process.pid}`);
mkdirSync(lockRoot, { recursive: true });
try {
  const release = acquireTestLock({
    projectName: first,
    lockRoot,
    isProcessActive: () => true,
  });
  assert.throws(
    () => acquireTestLock({ projectName: first, lockRoot, isProcessActive: () => true }),
    /Another PostgreSQL test run is active/,
    "a second run in the same worktree must fail before touching the active Compose project",
  );
  release();

  const staleLock = join(lockRoot, `${first}.lock`);
  writeFileSync(staleLock, "999999\n", "utf8");
  const releaseAfterCrash = acquireTestLock({
    projectName: first,
    lockRoot,
    isProcessActive: () => false,
  });
  assert.equal(existsSync(staleLock), true, "a stale lock must be replaced by the current run");
  releaseAfterCrash();
  assert.equal(existsSync(staleLock), false, "the current run must release its lock");
} finally {
  rmSync(lockRoot, { recursive: true, force: true });
}

console.log("test runner isolation tests passed");
