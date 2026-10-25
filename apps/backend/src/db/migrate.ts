/**
 * Database migration runner. Idempotent and versioned.
 */
import type { Pool, PoolClient } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export async function runMigrations(pool: Pool | PoolClient): Promise<void> {
  const schemaPath = fileURLToPath(new URL("../../../../db/schema.sql", import.meta.url));
  const schemaSql = readFileSync(schemaPath, "utf8");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const appliedRes = await pool.query<{ id: number }>(
    "SELECT id FROM schema_migrations ORDER BY id ASC",
  );
  const appliedIds = new Set(appliedRes.rows.map((r) => r.id));

  const migrations: Migration[] = [
    { id: 1, name: "initial_schema_v1", sql: schemaSql },
  ];

  for (const m of migrations) {
    if (appliedIds.has(m.id)) continue;

    // Apply migration in a transaction
    await pool.query("BEGIN");
    try {
      await pool.query(m.sql);
      await pool.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [
        m.id,
        m.name,
      ]);
      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }
  }
}
