// Database adapter: node-postgres when DATABASE_URL is set (Railway),
// embedded PGlite (real Postgres, WASM) for zero-setup local development.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { config } from './config.js';

export interface Conn {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Conn {
  tx<T>(fn: (c: Conn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const big = (x: unknown): bigint => BigInt(String(x));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (pubkey TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS auth_challenges (nonce TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL, used BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, pubkey TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS used_nip98 (event_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY,
  creator_pubkey TEXT NOT NULL,
  unit TEXT NOT NULL,
  name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  description TEXT NOT NULL,
  image_hash TEXT NOT NULL,
  image_mime TEXT NOT NULL,
  image BYTEA NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_event JSONB NOT NULL,
  manifest_hash TEXT NOT NULL,
  supply BIGINT NOT NULL DEFAULT 0,
  reserve_sats BIGINT NOT NULL DEFAULT 0,
  locked_supply BIGINT NOT NULL DEFAULT 0,
  creator_fee_accrued BIGINT NOT NULL DEFAULT 0,
  creator_fee_claimed BIGINT NOT NULL DEFAULT 0,
  trade_count BIGINT NOT NULL DEFAULT 0,
  volume_sats BIGINT NOT NULL DEFAULT 0,
  first_buy_units BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  announcement_state TEXT NOT NULL DEFAULT 'ANNOUNCEMENT_PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (supply >= 0 AND supply <= 21000000),
  CHECK (locked_supply >= 0 AND locked_supply <= supply),
  CHECK (creator_fee_claimed <= creator_fee_accrued)
);
CREATE TABLE IF NOT EXISTS keysets (
  keyset_id TEXT PRIMARY KEY, scope TEXT NOT NULL, asset_id TEXT, unit TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS launches (
  launch_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, first_trade_id TEXT NOT NULL, launch_fee_sats BIGINT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proofs (
  y TEXT PRIMARY KEY, keyset_id TEXT NOT NULL, amount BIGINT NOT NULL, state TEXT NOT NULL DEFAULT 'SPENT',
  spent_at TIMESTAMPTZ NOT NULL DEFAULT now(), op_ref TEXT
);
CREATE TABLE IF NOT EXISTS outgoing_signatures (
  blinded_message TEXT PRIMARY KEY, keyset_id TEXT NOT NULL, amount BIGINT NOT NULL, signature TEXT NOT NULL,
  operation_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outgoing_op_idx ON outgoing_signatures(operation_id);
CREATE TABLE IF NOT EXISTS trades (
  trade_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, seq BIGINT NOT NULL, side TEXT NOT NULL,
  delta_units BIGINT NOT NULL, gross_sats BIGINT NOT NULL, fee_sats BIGINT NOT NULL,
  reserve_after BIGINT NOT NULL, supply_after BIGINT NOT NULL, receipt_sig TEXT NOT NULL,
  audit_seq BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, seq)
);
CREATE TABLE IF NOT EXISTS fee_allocations (
  asset_id TEXT NOT NULL, idx INT NOT NULL, recipient_pubkey TEXT NOT NULL, weight_bps INT NOT NULL,
  PRIMARY KEY (asset_id, idx)
);
CREATE TABLE IF NOT EXISTS fee_balances (
  asset_id TEXT NOT NULL, recipient_pubkey TEXT NOT NULL,
  accrued_sats BIGINT NOT NULL DEFAULT 0, claimed_sats BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (asset_id, recipient_pubkey), CHECK (claimed_sats <= accrued_sats)
);
CREATE TABLE IF NOT EXISTS platform_ledger (id INT PRIMARY KEY, fees_sats BIGINT NOT NULL DEFAULT 0);
INSERT INTO platform_ledger (id, fees_sats) VALUES (1, 0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS vaults (
  vault_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, creator_pubkey TEXT NOT NULL,
  beneficiary_commitment TEXT NOT NULL, beneficiary_pubkey TEXT NOT NULL, salt TEXT NOT NULL,
  amount BIGINT NOT NULL, unlock_at TIMESTAMPTZ NOT NULL, state TEXT NOT NULL DEFAULT 'LOCKED',
  claim_id TEXT, lock_audit_seq BIGINT NOT NULL, lock_receipt_sig TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY, claim_type TEXT NOT NULL, claimant_pubkey TEXT NOT NULL, status TEXT NOT NULL,
  output_commitment TEXT NOT NULL, result_ref JSONB
);
CREATE TABLE IF NOT EXISTS mint_quotes (
  quote_id TEXT PRIMARY KEY, amount BIGINT NOT NULL, bolt11 TEXT NOT NULL, payment_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'UNPAID', expires_at TIMESTAMPTZ NOT NULL, output_commitment TEXT, result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS melt_quotes (
  quote_id TEXT PRIMARY KEY, bolt11 TEXT NOT NULL, payment_hash TEXT NOT NULL UNIQUE, amount BIGINT NOT NULL,
  fee_reserve BIGINT NOT NULL, state TEXT NOT NULL DEFAULT 'UNPAID', expires_at TIMESTAMPTZ NOT NULL,
  inputs_total BIGINT, change_outputs JSONB, output_commitment TEXT, preimage TEXT, fee_paid BIGINT, result JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS treasury_proofs (
  secret TEXT PRIMARY KEY, keyset_id TEXT NOT NULL, amount BIGINT NOT NULL, proof JSONB NOT NULL, state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS treasury_counters (keyset_id TEXT PRIMARY KEY, next INT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS upstream_quotes (
  quote_id TEXT PRIMARY KEY, amount BIGINT NOT NULL, bolt11 TEXT NOT NULL, payment_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'UNPAID', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS upstream_melts (
  payment_hash TEXT PRIMARY KEY, quote_id TEXT NOT NULL, state TEXT NOT NULL, send_proofs JSONB NOT NULL,
  fee_reserve BIGINT NOT NULL, preimage TEXT, fee_paid BIGINT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_head (id INT PRIMARY KEY, size BIGINT NOT NULL DEFAULT 0);
INSERT INTO audit_head (id, size) VALUES (1, 0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS audit_events (
  seq BIGINT PRIMARY KEY, event_type TEXT NOT NULL, payload TEXT NOT NULL, leaf_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_checkpoints (
  size BIGINT PRIMARY KEY, log_root TEXT NOT NULL, state_root TEXT NOT NULL, totals JSONB NOT NULL,
  signed_event JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, payload JSONB NOT NULL, event_id TEXT NOT NULL UNIQUE,
  delivery_state TEXT NOT NULL DEFAULT 'PENDING', attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error TEXT, ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY, operation TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL,
  result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function makePg(url: string): Promise<Db> {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  return {
    query: (sql, params) => pool.query(sql, params as any[]) as any,
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn({ query: (s, p) => c.query(s, p as any[]) as any });
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

async function makeLite(dir: string | undefined): Promise<Db> {
  if (dir) mkdirSync(dirname(dir), { recursive: true });
  const lite = dir ? new PGlite(dir) : new PGlite();
  await lite.waitReady;
  return {
    query: (sql, params) => lite.query(sql, params as any[]) as any,
    tx: (fn) => lite.transaction((t) => fn({ query: (s, p) => t.query(s, p as any[]) as any })),
    close: () => lite.close(),
  };
}

export async function openDb(): Promise<Db> {
  const db = config.databaseUrl ? await makePg(config.databaseUrl) : await makeLite(config.pgliteDir);
  // Multi-statement schema: run statement by statement for driver parity.
  for (const stmt of SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  return db;
}
