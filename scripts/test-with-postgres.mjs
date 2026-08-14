import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

const compose = ["compose", "-f", "compose.test.yaml"];

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

const postgresPort = await findFreePort();
const composeEnv = { ...process.env, POSTGRES_TEST_PORT: String(postgresPort) };
const databaseUrl = `postgresql://garment_test:garment_test@127.0.0.1:${postgresPort}/garment_canvas_test`;

try {
  run("docker", [...compose, "down", "--volumes", "--remove-orphans"], { env: composeEnv });
  run("docker", [...compose, "up", "-d", "--wait"], { env: composeEnv });
  run(process.execPath, [process.env.npm_execpath, "run", "test:suite"], {
    env: { ...composeEnv, DATABASE_URL: databaseUrl },
  });
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
}
