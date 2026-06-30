import crypto from "node:crypto";
import { sql } from "@vercel/postgres";

type StoredEnvelope = {
  encrypted?: boolean;
  value?: unknown;
  iv?: string;
  tag?: string;
  data?: string;
};

const memoryStore = new Map<string, { value: StoredEnvelope; expiresAt: string | null }>();
let schemaReadyPromise: Promise<void> | null = null;

function hasPostgres(): boolean {
  return Boolean(
    process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.POSTGRES_URL_NO_SSL
  );
}

function getEncryptionKey(): Buffer | null {
  const secret = process.env.SERVERLESS_STATE_SECRET?.trim();
  if (!secret) {
    return null;
  }

  return crypto.createHash("sha256").update(secret).digest();
}

function encodeValue(value: unknown): StoredEnvelope {
  const key = getEncryptionKey();
  if (!key) {
    return { value };
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);

  return {
    encrypted: true,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64")
  };
}

function decodeValue<T>(envelope: StoredEnvelope): T | null {
  if (!envelope.encrypted) {
    return (envelope.value ?? null) as T | null;
  }

  const key = getEncryptionKey();
  if (!key || !envelope.iv || !envelope.tag || !envelope.data) {
    return null;
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const text = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(text) as T;
}

async function ensureSchema(): Promise<void> {
  if (!hasPostgres()) {
    return;
  }

  if (!schemaReadyPromise) {
    schemaReadyPromise = sql`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        expires_at TIMESTAMPTZ NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.then(() => undefined);
  }

  await schemaReadyPromise;
}

export async function getState<T>(key: string): Promise<T | null> {
  if (!hasPostgres()) {
    const entry = memoryStore.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= Date.now()) {
      memoryStore.delete(key);
      return null;
    }

    return decodeValue<T>(entry.value);
  }

  await ensureSchema();
  const result = await sql`
    SELECT value
    FROM app_state
    WHERE key = ${key}
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `;

  const row = result.rows[0] as { value: StoredEnvelope } | undefined;
  return row ? decodeValue<T>(row.value) : null;
}

export async function setState(key: string, value: unknown, options: { ttlMs?: number } = {}): Promise<void> {
  const envelope = encodeValue(value);
  const expiresAt = options.ttlMs ? new Date(Date.now() + options.ttlMs).toISOString() : null;

  if (!hasPostgres()) {
    memoryStore.set(key, { value: envelope, expiresAt });
    return;
  }

  await ensureSchema();
  await sql`
    INSERT INTO app_state (key, value, expires_at, updated_at)
    VALUES (${key}, ${JSON.stringify(envelope)}::jsonb, ${expiresAt}, NOW())
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = NOW()
  `;
}

export async function deleteState(key: string): Promise<void> {
  if (!hasPostgres()) {
    memoryStore.delete(key);
    return;
  }

  await ensureSchema();
  await sql`DELETE FROM app_state WHERE key = ${key}`;
}
