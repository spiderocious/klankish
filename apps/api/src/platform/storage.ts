import { createHash, createHmac } from 'node:crypto';

import { env, storageConfigured } from './env.js';
import { subLogger } from './logger.js';

/**
 * Object storage (AWS S3 / Cloudflare R2), behind a port.
 *
 * SigV4 is implemented directly rather than pulling in `@aws-sdk/client-s3`, which is ~20MB of
 * transitive dependencies for four operations. The signing algorithm is well-specified and
 * unchanging, and keeping it here means the whole storage path is auditable in one file.
 *
 * Both providers speak the same protocol; R2 needs path-style addressing, which is why
 * S3_FORCE_PATH_STYLE defaults to true.
 */

const log = subLogger('storage');

export interface PutInput {
  readonly key: string;
  readonly body: string | Buffer;
  readonly contentType?: string;
}

export interface PutResult {
  readonly key: string;
  readonly bytes: number;
  readonly checksum: string;
}

export interface ObjectStore {
  readonly configured: boolean;
  put(input: PutInput): Promise<PutResult>;
  get(key: string): Promise<{ body: string; bytes: number } | null>;
  delete(key: string): Promise<void>;
  /** A time-limited URL so the browser can fetch a large payload without proxying it. */
  presignGet(key: string, expiresInSeconds?: number): string | null;
}

class UnconfiguredStore implements ObjectStore {
  readonly configured = false;

  private fail(op: string): never {
    // A truthful error, not a silent no-op: a task that thinks it stored a file and did not is
    // worse than one that fails visibly.
    throw new Error(
      `Object storage is not configured on this instance, so "${op}" cannot run. ` +
        'Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
    );
  }

  async put(): Promise<PutResult> {
    this.fail('storage_put');
  }
  async get(): Promise<null> {
    this.fail('storage_get');
  }
  async delete(): Promise<void> {
    this.fail('delete');
  }
  presignGet(): null {
    return null;
  }
}

const UNSIGNED_PAYLOAD_HASH_EMPTY =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * URI-encode a path segment per SigV4's rules.
 *
 * `encodeURIComponent` leaves `!'()*` alone, and AWS requires them encoded. Getting this wrong
 * produces a signature mismatch on exactly the keys that contain those characters, which is a
 * miserable bug to track down.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeSegment).join('/');
}

class S3Store implements ObjectStore {
  readonly configured = true;

  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly pathStyle: boolean;

  constructor() {
    this.bucket = env.S3_BUCKET!;
    this.region = env.S3_REGION;
    this.accessKeyId = env.S3_ACCESS_KEY_ID!;
    this.secretAccessKey = env.S3_SECRET_ACCESS_KEY!;
    this.pathStyle = env.S3_FORCE_PATH_STYLE;
    this.endpoint = (env.S3_ENDPOINT ?? `https://s3.${this.region}.amazonaws.com`).replace(
      /\/$/,
      '',
    );
  }

  private urlFor(key: string): { url: URL; host: string; path: string } {
    const encoded = encodeKey(key);
    const base = new URL(this.endpoint);

    if (this.pathStyle) {
      const url = new URL(`${this.endpoint}/${this.bucket}/${encoded}`);
      return { url, host: url.host, path: `/${this.bucket}/${encoded}` };
    }

    const url = new URL(`${base.protocol}//${this.bucket}.${base.host}/${encoded}`);
    return { url, host: url.host, path: `/${encoded}` };
  }

  /** SigV4 signing key: a chain of HMACs over date, region, service, and the terminator. */
  private signingKey(dateStamp: string): Buffer {
    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    return hmac(kService, 'aws4_request');
  }

  private sign(
    method: string,
    path: string,
    host: string,
    payloadHash: string,
    extraHeaders: Record<string, string> = {},
  ): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };

    // Canonical headers must be lowercase, sorted, and trimmed — the signature depends on it.
    const sortedKeys = Object.keys(headers)
      .map((k) => k.toLowerCase())
      .sort();
    const canonicalHeaders = sortedKeys
      .map((k) => `${k}:${String(headers[k] ?? headers[Object.keys(headers).find((h) => h.toLowerCase() === k) ?? '']).trim()}\n`)
      .join('');
    const signedHeaders = sortedKeys.join(';');

    const canonicalRequest = [
      method,
      path,
      '', // no query string on these operations
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = hmac(this.signingKey(dateStamp), stringToSign).toString('hex');

    return {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  async put(input: PutInput): Promise<PutResult> {
    const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
    const payloadHash = sha256Hex(body);
    const { url, host, path } = this.urlFor(input.key);

    const headers = this.sign('PUT', path, host, payloadHash, {
      'content-type': input.contentType ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
    });

    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Storage PUT failed (${res.status}): ${text.slice(0, 300)}`);
    }

    return { key: input.key, bytes: body.byteLength, checksum: payloadHash };
  }

  async get(key: string): Promise<{ body: string; bytes: number } | null> {
    const { url, host, path } = this.urlFor(key);
    const headers = this.sign('GET', path, host, UNSIGNED_PAYLOAD_HASH_EMPTY);

    const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(60_000) });

    // A missing object is a legitimate answer, not an error — the caller decides what it means.
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Storage GET failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const body = await res.text();
    return { body, bytes: Buffer.byteLength(body, 'utf8') };
  }

  async delete(key: string): Promise<void> {
    const { url, host, path } = this.urlFor(key);
    const headers = this.sign('DELETE', path, host, UNSIGNED_PAYLOAD_HASH_EMPTY);
    const res = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(30_000) });
    // 204 on success, 404 when already gone — both mean "it is not there", which is what was asked.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Storage DELETE failed (${res.status})`);
    }
  }

  presignGet(key: string, expiresInSeconds = 3600): string {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const { url, host, path } = this.urlFor(key);

    const params = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresInSeconds),
      'X-Amz-SignedHeaders': 'host',
    });

    const canonicalRequest = [
      'GET',
      path,
      params.toString(),
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = hmac(this.signingKey(dateStamp), stringToSign).toString('hex');
    params.set('X-Amz-Signature', signature);

    return `${url.origin}${path}?${params.toString()}`;
  }
}

export const storage: ObjectStore = storageConfigured ? new S3Store() : new UnconfiguredStore();

if (!storageConfigured) {
  log.info('object storage is not configured — storage steps will fail with a clear message');
}

/** Namespaced key, so one bucket can hold many users' artifacts without collision. */
export function artifactKey(ownerId: string, runId: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return `artifacts/${ownerId}/${runId}/${safe}`;
}
