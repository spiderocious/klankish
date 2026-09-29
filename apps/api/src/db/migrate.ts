import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './client.js';
import { subLogger } from '../platform/logger.js';

/**
 * Migration runner.
 *
 * Forward-only, plain SQL, one file per change. Run as a SEPARATE release step — never from
 * application startup, because N replicas booting at once would race each other through the same
 * migrations.
 *
 * Each file runs inside its own transaction, so a failure leaves the database at the last
 * successfully applied version rather than half-way through one.
 */

const log = subLogger('migrate');
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface AppliedRow {
  version: string;
  checksum: string;
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT        PRIMARY KEY,
      name       TEXT        NOT NULL,
      checksum   TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function checksum(sql: string): string {
  // Normalise line endings so the same file does not appear changed across platforms.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

export async function runMigrations(): Promise<MigrationResult> {
  await ensureMigrationsTable();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort(); // NNNN_ prefix makes lexicographic order == intended order

  const { rows } = await pool.query<AppliedRow>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const file of files) {
    const version = file.split('_')[0] ?? file;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const sum = checksum(sql);

    const previous = applied.get(version);
    if (previous !== undefined) {
      // A committed migration must never be edited: some databases already ran the old version,
      // so editing it means two environments silently have different schemas. Fix forward.
      if (previous !== sum) {
        throw new Error(
          `Migration ${file} has changed since it was applied ` +
            `(was ${previous}, now ${sum}). Migrations are forward-only — ` +
            `write a new migration instead of editing this one.`,
        );
      }
      result.skipped.push(file);
      continue;
    }

    log.info({ file }, 'applying migration');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [version, file, sum],
      );
      await client.query('COMMIT');
      result.applied.push(file);
      log.info({ file }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      log.error({ err, file }, 'migration failed — rolled back');
      throw err;
    } finally {
      client.release();
    }
  }

  return result;
}

/** Drop and recreate the public schema. Test databases only — guarded hard. */
export async function resetDatabase(): Promise<void> {
  const url = process.env['DATABASE_URL'] ?? '';
  if (!url.includes('test')) {
    throw new Error(
      `resetDatabase() refused: DATABASE_URL does not look like a test database (${url}).`,
    );
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

/**
 * Truncate every table between tests.
 *
 * Much faster than recreating the schema, and `RESTART IDENTITY CASCADE` leaves the database in
 * the same state a fresh migration would.
 */
export async function truncateAll(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
  `);
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  // instance_settings is a singleton row the app expects to exist.
  await pool.query('INSERT INTO instance_settings (id) VALUES (1) ON CONFLICT DO NOTHING');
}
