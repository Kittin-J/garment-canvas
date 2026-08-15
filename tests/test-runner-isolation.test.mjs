import assert from "node:assert/strict";

import { createComposeProjectName } from "../scripts/test-with-postgres.mjs";

const first = createComposeProjectName({ cwd: "/tmp/worktree-a", pid: 100 });
const second = createComposeProjectName({ cwd: "/tmp/worktree-b", pid: 100 });
const concurrent = createComposeProjectName({ cwd: "/tmp/worktree-a", pid: 101 });

assert.match(first, /^garment-canvas-test-[a-f0-9]{10}-100$/);
assert.notEqual(first, second, "different worktrees must use different Compose projects");
assert.notEqual(first, concurrent, "concurrent runs must use different Compose projects");

console.log("test runner isolation tests passed");
