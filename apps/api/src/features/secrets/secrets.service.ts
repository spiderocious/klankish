import { ERROR_CODES, newId, type SecretView } from '@klankish/shared';

import { query, isPgError, PG_ERRORS } from '../../db/client.js';
import {
  CURRENT_KEY_VERSION,
  decryptSecret,
  encryptSecret,
} from '../../platform/crypto.js';
import { subLogger } from '../../platform/logger.js';
import { fail, failures, ok, type ServiceResult } from '../../platform/result.js';
import { auditRepo } from '../audit/audit.repo.js';

/**
 * Secrets.
 *
 * The rule that shapes every function here: **there is no code path that returns a plaintext
 * secret over HTTP.** Not for an admin, not for the owner. The only consumer of a decrypted value
 * is the engine, in memory, during a run — and even there it is registered for redaction the
 * moment it is used.
 *
 * `SecretView` has no value field, so a plaintext cannot be leaked by a careless serialiser: the
 * type simply does not have anywhere to put it.
 */

const log = subLogger('secrets');

interface SecretRow {
  id: string;
  owner_id: string;
  name: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

function toView(row: Omit<SecretRow, 'ciphertext' | 'iv' | 'auth_tag'>): SecretView {
  return {
    id: row.id,
    name: row.name,
    last_used_at: row.last_used_at,
    key_version: row.key_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const VIEW_COLUMNS = 'id, owner_id, name, key_version, last_used_at, created_at, updated_at';

export const secretsService = {
  async list(ownerId: string): Promise<ServiceResult<SecretView[]>> {
    const rows = await query<Omit<SecretRow, 'ciphertext' | 'iv' | 'auth_tag'>>(
      `SELECT ${VIEW_COLUMNS} FROM secrets WHERE owner_id = $1 ORDER BY name`,
      [ownerId],
    );
    return ok(rows.map(toView));
  },

  async create(
    ownerId: string,
    input: { name: string; value: string },
  ): Promise<ServiceResult<SecretView>> {
    const name = input.name.trim();

    // The charset must match what the expression lexer accepts as an identifier, or the secret
    // could be stored but never referenceable as {{ secrets.NAME }}.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      return failures.validation({
        name: ['Use letters, numbers and underscores, starting with a letter or underscore.'],
      });
    }
    if (input.value === '') {
      return failures.validation({ value: ['A value is required.'] });
    }

    const enc = encryptSecret(input.value);

    try {
      const rows = await query<Omit<SecretRow, 'ciphertext' | 'iv' | 'auth_tag'>>(
        `INSERT INTO secrets (id, owner_id, name, ciphertext, iv, auth_tag, key_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${VIEW_COLUMNS}`,
        [newId('secret'), ownerId, name, enc.ciphertext, enc.iv, enc.authTag, enc.keyVersion],
      );

      const row = rows[0];
      if (row === undefined) throw new Error('insert returned no row');

      // The audit entry records the NAME only. Recording the value would defeat the encryption.
      await auditRepo.record({
        action: 'secret.created',
        subjectType: 'secret',
        subjectId: row.id,
        after: { name },
      });

      return ok(toView(row));
    } catch (err) {
      if (isPgError(err, PG_ERRORS.UNIQUE_VIOLATION)) {
        return fail(ERROR_CODES.NAME_TAKEN, { rejection: 'secret_name_exists' });
      }
      throw err;
    }
  },

  async update(
    ownerId: string,
    id: string,
    value: string,
  ): Promise<ServiceResult<SecretView>> {
    if (value === '') return failures.validation({ value: ['A value is required.'] });

    const enc = encryptSecret(value);
    const rows = await query<Omit<SecretRow, 'ciphertext' | 'iv' | 'auth_tag'>>(
      `UPDATE secrets
       SET ciphertext = $3, iv = $4, auth_tag = $5, key_version = $6
       WHERE id = $1 AND owner_id = $2
       RETURNING ${VIEW_COLUMNS}`,
      [id, ownerId, enc.ciphertext, enc.iv, enc.authTag, enc.keyVersion],
    );

    const row = rows[0];
    if (row === undefined) return failures.notFound('secret');

    await auditRepo.record({
      action: 'secret.updated',
      subjectType: 'secret',
      subjectId: id,
      after: { name: row.name },
    });

    return ok(toView(row));
  },

  async remove(ownerId: string, id: string): Promise<ServiceResult<null>> {
    const rows = await query<{ name: string }>(
      'DELETE FROM secrets WHERE id = $1 AND owner_id = $2 RETURNING name',
      [id, ownerId],
    );
    if (rows.length === 0) return failures.notFound('secret');

    await auditRepo.record({
      action: 'secret.deleted',
      subjectType: 'secret',
      subjectId: id,
      before: { name: rows[0]?.name },
    });

    return ok(null);
  },

  /** Names only — for the task builder's autocomplete and for graph validation. */
  async namesFor(ownerId: string): Promise<Set<string>> {
    const rows = await query<{ name: string }>('SELECT name FROM secrets WHERE owner_id = $1', [
      ownerId,
    ]);
    return new Set(rows.map((r) => r.name));
  },
};

/**
 * Decrypt every secret an owner holds, for one run.
 *
 * The ONLY function in the codebase that returns plaintext, and it is not reachable from any HTTP
 * route — the worker calls it directly. A secret that fails to decrypt is skipped with a loud log
 * rather than crashing the run: one rotated-but-not-re-encrypted secret should not take down
 * every task the user owns.
 */
export async function secretsForOwner(ownerId: string): Promise<Record<string, string>> {
  const rows = await query<{
    id: string;
    name: string;
    ciphertext: Buffer;
    iv: Buffer;
    auth_tag: Buffer;
    key_version: number;
  }>(
    'SELECT id, name, ciphertext, iv, auth_tag, key_version FROM secrets WHERE owner_id = $1',
    [ownerId],
  );

  const out: Record<string, string> = {};
  const usedIds: string[] = [];

  for (const row of rows) {
    try {
      out[row.name] = decryptSecret({
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        keyVersion: row.key_version,
      });
      usedIds.push(row.id);
    } catch (err) {
      log.error(
        { err, secret_id: row.id, name: row.name, key_version: row.key_version },
        'could not decrypt secret — it may have been encrypted under a different key',
      );
    }
  }

  if (usedIds.length > 0) {
    // Fire-and-forget: last_used_at drives an "unused secret" hint in the UI and is not worth
    // delaying a run for.
    void query('UPDATE secrets SET last_used_at = now() WHERE id = ANY($1)', [usedIds]).catch(
      () => undefined,
    );
  }

  return out;
}

export { CURRENT_KEY_VERSION };
