import pg, { type PoolClient, type QueryResultRow } from "pg";
import { nanoid } from "nanoid";
import { config } from "../config";
import { hashPassword, validatePassword } from "./password";
import { importSqliteIfNeeded } from "./sqliteImport";

const { Pool, types } = pg;
types.setTypeParser(20, Number);

let pool: pg.Pool | undefined;
let initialization: Promise<void> | undefined;

export function db(): pg.Pool {
  if (!pool) {
    const connectionString = config.databaseUrl();
    pool = new Pool({
      ...(connectionString
        ? { connectionString }
        : {
            host: config.databaseHost(),
            port: config.databasePort(),
            database: config.databaseName(),
            user: config.databaseUser(),
            password: config.databasePassword(),
          }),
      max: config.databasePoolSize(),
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (error) => console.error("[garment-canvas] PostgreSQL idle client error", error));
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
  client: pg.Pool | PoolClient = db(),
): Promise<T[]> {
  return (await client.query<T>(text, values)).rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
  client: pg.Pool | PoolClient = db(),
): Promise<T | undefined> {
  return (await client.query<T>(text, values)).rows[0];
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase(): Promise<void> {
  initialization ??= (async () => {
    await migrate();
    await importSqliteIfNeeded();
    await bootstrapInitialAdmin();
  })();
  return initialization;
}

export async function closeDatabaseForTests(): Promise<void> {
  const current = pool;
  pool = undefined;
  initialization = undefined;
  if (current) await current.end();
}

async function migrate(): Promise<void> {
  await db().query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','user')),
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      flow_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      purge_after TEXT
    );
    CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id),
      source_type TEXT NOT NULL DEFAULT 'upload',
      project_id TEXT,
      node_id TEXT,
      run_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_owner_idx ON files(owner_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id),
      scope TEXT NOT NULL CHECK (scope IN ('global','private','shared')),
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('print','fabric','reference')),
      image TEXT NOT NULL,
      source_note TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      purge_after TEXT
    );
    CREATE INDEX IF NOT EXISTS assets_scope_owner_idx ON assets(scope, owner_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_asset_refs (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id)
    );

    CREATE TABLE IF NOT EXISTS generation_runs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT,
      project_name TEXT,
      node_id TEXT NOT NULL,
      node_label TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      parameters_json TEXT,
      reference_images_json TEXT,
      model TEXT,
      requested_count INTEGER NOT NULL DEFAULT 1,
      successful_count INTEGER NOT NULL DEFAULT 0,
      provider_requests INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('queued','running','success','error')),
      error TEXT,
      started_at BIGINT NOT NULL,
      finished_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS generation_runs_owner_idx ON generation_runs(owner_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS generation_outputs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
      image TEXT NOT NULL DEFAULT '',
      prompt TEXT,
      status TEXT NOT NULL CHECK (status IN ('success','error')),
      error TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS generation_outputs_run_idx ON generation_outputs(run_id, created_at);

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      run_id TEXT NOT NULL UNIQUE REFERENCES generation_runs(id) ON DELETE RESTRICT,
      project_id TEXT,
      node_id TEXT NOT NULL,
      model TEXT,
      successful_count INTEGER NOT NULL CHECK (successful_count > 0),
      provider_requests INTEGER NOT NULL DEFAULT 1,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_owner_idx ON usage_events(owner_id, created_at DESC);
  `);
}

async function bootstrapInitialAdmin(): Promise<void> {
  const row = await queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM users");
  if ((row?.count ?? 0) > 0) return;
  const accountId = config.initialAdminAccountId();
  const password = config.initialAdminPassword();
  if (!accountId || !password) return;
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(`INITIAL_ADMIN_PASSWORD 不符合要求：${passwordError}`);
  const now = new Date().toISOString();
  await db().query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, must_change_password, active, created_at, updated_at)
    VALUES ($1, $2, $3, 'admin', $4, 1, 1, $5, $5)
    ON CONFLICT (account_id) DO NOTHING
  `, [nanoid(12), accountId, "管理员", hashPassword(password), now]);
}

export async function hasUsers(): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>("SELECT EXISTS(SELECT 1 FROM users) AS ok");
  return row?.ok === true;
}

export async function databaseReady(): Promise<boolean> {
  try {
    await db().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
