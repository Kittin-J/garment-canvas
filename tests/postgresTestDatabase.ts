import pg from "pg";

export async function resetPostgresTestDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL tests");
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.slice(1);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !databaseName.endsWith("_test")) {
    throw new Error("Refusing to reset a PostgreSQL database that is not a local *_test database");
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
}
