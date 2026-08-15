import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

function deny(message) {
  process.stderr.write(
    `${JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny" },
      systemMessage: message,
    })}\n`,
  );
  process.exit(2);
}

function gitPath(cwd, flag) {
  const result = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", flag],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) return null;

  const path = result.stdout.trim();
  if (!path) return null;
  try {
    return realpathSync(path);
  } catch {
    return resolve(cwd, path);
  }
}

function isLinkedWorktree(cwd) {
  const gitDir = gitPath(cwd, "--git-dir");
  const commonDir = gitPath(cwd, "--git-common-dir");
  if (!gitDir || !commonDir) return null;
  return gitDir !== commonDir;
}

function containsSensitivePath(value) {
  const withoutPublicExample = value.replaceAll(".env.example", "");
  return (
    /(?:^|[\\/\s"'=])\.env(?:[.\\/\s"']|$)/i.test(withoutPublicExample) ||
    /(?:^|[\\/])\.secrets(?:[\\/]|$)/i.test(value)
  );
}

function forbiddenBashReason(command) {
  if (containsSensitivePath(command)) return "Reading private environment or secret files is blocked.";

  const forbidden = [
    [/(?:^|[;&|\n]\s*)[^;&|\n]*\bgit\b[^;&|\n]*\bpush\b/i, "Remote git writes are blocked."],
    [/(?:^|[;&|\n]\s*)[^;&|\n]*\bgh\b[^;&|\n]*\bpr\s+create\b/i, "Pull request creation is blocked."],
    [/(?:^|[;&|\n]\s*)[^;&|\n]*\bgit\b[^;&|\n]*\b(?:merge|rebase|cherry-pick|clean)\b/i, "History-changing git commands are blocked."],
    [/(?:^|[;&|\n]\s*)[^;&|\n]*\bgit\b[^;&|\n]*\breset\b[^;&|\n]*--hard\b/i, "Hard reset is blocked."],
    [/(?:^|[;&|\n]\s*)[^;&|\n]*\b(?:npm|pnpm|yarn|bun)\b[^;&|\n]*\b(?:install|i|ci|add|remove|uninstall|update|upgrade)\b/i, "Dependency installation is blocked because worktrees share node_modules."],
  ];

  return forbidden.find(([pattern]) => pattern.test(command))?.[1] ?? null;
}

function isReadOnlyGit(segment) {
  const match = segment.match(
    /^(?:(?:\/[^\s]+\/)?git)\s+(?:(?:-C|--git-dir|--work-tree)\s+(?:"[^"]+"|'[^']+'|\S+)\s+)*(\S+)(.*)$/i,
  );
  if (!match) return false;

  const [, subcommand, args] = match;
  if (/--output(?:=|\s)/i.test(args)) return false;
  if (subcommand === "branch") return /^\s+--show-current\s*$/.test(args);
  if (subcommand === "worktree") return /^\s+list(?:\s|$)/.test(args);
  if (subcommand === "remote") return /^\s+(?:-v|show(?:\s|$)|get-url(?:\s|$))/.test(args);
  return [
    "status",
    "diff",
    "log",
    "show",
    "rev-parse",
    "ls-files",
    "ls-tree",
    "cat-file",
    "grep",
    "describe",
    "name-rev",
  ].includes(subcommand);
}

function isReadOnlySegment(segment) {
  const trimmed = segment.trim();
  if (!trimmed) return true;
  if (isReadOnlyGit(trimmed)) return true;
  if (/^(?:command\s+-v|which|pwd)(?:\s|$)/.test(trimmed)) return true;

  const match = trimmed.match(/^(?:(?:\/[^\s]+\/)?)([a-z0-9_-]+)(?:\s|$)/i);
  if (!match) return false;
  const command = match[1];
  if (!["ls", "rg", "grep", "cat", "head", "tail", "wc", "cut", "tr", "jq", "file", "stat", "realpath", "dirname", "basename", "sed"].includes(command)) {
    return false;
  }
  if (command === "sed" && /(?:^|\s)(?:-[^\s]*i[^\s]*|--in-place(?:=\S*)?)(?:\s|$)/.test(trimmed)) return false;
  if (command === "rg" && /(?:^|\s)(?:--hidden|--no-ignore|-u{1,3}|--pre)(?:\s|=|$)/.test(trimmed)) return false;
  return true;
}

function isReadOnlyBash(command) {
  if (!command.trim()) return false;
  if (/[<>`]/.test(command) || /\$\(/.test(command)) return false;
  if (/(^|[^&])&([^&]|$)/.test(command)) return false;
  if (/\b(?:tee|xargs)\b/.test(command)) return false;

  return command
    .split(/(?:&&|\|\||[;|\n])/)
    .every((segment) => isReadOnlySegment(segment));
}

let input;
try {
  input = JSON.parse(await new Promise((resolveInput, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolveInput(value));
    process.stdin.on("error", reject);
  }));
} catch {
  deny("Unable to validate this tool call because the hook input was invalid.");
}

const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
const toolName = input.tool_name;
const filePath = input.tool_input?.file_path;

if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
  if (typeof filePath === "string" && containsSensitivePath(filePath)) {
    deny("Access to private .env or .secrets files is blocked; use .env.example as the public contract.");
  }
}

if (toolName === "Read") {
  process.exit(0);
}

if (toolName === "Bash") {
  const command = input.tool_input?.command;
  if (typeof command !== "string") deny("A Bash tool call without a command is blocked.");
  const reason = forbiddenBashReason(command);
  if (reason) deny(reason);
}

const linked = isLinkedWorktree(cwd);
if (linked === true) process.exit(0);
if (linked === null) deny("Claude could not verify that the current directory is a linked git worktree.");

if (toolName === "Write" || toolName === "Edit") {
  deny("The primary worktree is audit-only. Restart with: claude --worktree <task-name>");
}

if (toolName === "Bash" && !isReadOnlyBash(input.tool_input.command)) {
  deny("Only a conservative read-only Bash allowlist is available in the primary worktree. Use Read/Grep/GitNexus, or restart with claude --worktree <task-name>.");
}
