import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function createComposeProjectName({ cwd = process.cwd() } = {}) {
  const worktreeId = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 10);
  return `garment-canvas-test-${worktreeId}`;
}

function processIsActive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireTestLock({
  projectName,
  pid = process.pid,
  lockRoot = tmpdir(),
  isProcessActive = processIsActive,
} = {}) {
  if (!projectName) throw new Error("A Compose project name is required for the test lock");
  const lockPath = join(lockRoot, `${projectName}.lock`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, `${pid}\n`, "utf8");
      let released = false;
      return () => {
        if (released) return;
        released = true;
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
      }
      if (error?.code !== "EEXIST") throw error;

      let ownerPid;
      try {
        ownerPid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      if (isProcessActive(ownerPid)) {
        throw new Error(`Another PostgreSQL test run is active for this worktree (pid ${ownerPid})`);
      }
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }

  throw new Error(`Unable to acquire PostgreSQL test lock: ${lockPath}`);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a PostgreSQL test port"));
        return;
      }

      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function runNpmScript(script, env) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, "run", script], { env });
    return;
  }
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], { env });
}

async function main() {
  const composeProjectName = createComposeProjectName();
  const releaseLock = acquireTestLock({ projectName: composeProjectName });
  const compose = [
    "compose",
    "--project-name",
    composeProjectName,
    "-f",
    "compose.test.yaml",
  ];
  let composeEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: composeProjectName,
  };

  try {
    run("docker", [...compose, "down", "--volumes", "--remove-orphans"], { env: composeEnv });
    const postgresPort = await findFreePort();
    composeEnv = { ...composeEnv, POSTGRES_TEST_PORT: String(postgresPort) };
    const databaseUrl = `postgresql://garment_test:garment_test@127.0.0.1:${postgresPort}/garment_canvas_test`;
    run("docker", [...compose, "up", "-d", "--wait"], { env: composeEnv });
    runNpmScript("test:suite", { ...composeEnv, DATABASE_URL: databaseUrl });
  } catch (error) {
    spawnSync("docker", [...compose, "logs", "--no-color"], {
      stdio: "inherit",
      env: composeEnv,
    });
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], {
      stdio: "inherit",
      env: composeEnv,
    });
    releaseLock();
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) await main();
