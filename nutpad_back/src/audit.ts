// Public append-only Merkle log + signed checkpoints.
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent } from 'nostr-tools/pure';
import { big, type Conn } from './db.js';
import { leafHash, mth } from './merkle.js';
import { canonical, sha256Hex } from './util.js';
import type { Mint } from './mint.js';

export const leafData = (seq: number | bigint, type: string, payloadStr: string) => `${seq}|${type}|${payloadStr}`;

/** Must be called with the asset row already locked (lock order: asset -> audit_head). */
export async function appendEvent(c: Conn, type: string, payload: Record<string, unknown>): Promise<number> {
  const head = await c.query<{ size: unknown }>(`SELECT size FROM audit_head WHERE id=1 FOR UPDATE`);
  const seq = Number(big(head.rows[0].size)) + 1;
  const payloadStr = canonical({ ...payload, ts: new Date().toISOString() });
  const leaf = leafHash(utf8ToBytes(leafData(seq, type, payloadStr)));
  await c.query(`INSERT INTO audit_events(seq,event_type,payload,leaf_hash) VALUES($1,$2,$3,$4)`, [
    seq,
    type,
    payloadStr,
    leaf,
  ]);
  await c.query(`UPDATE audit_head SET size=$1 WHERE id=1`, [seq]);
  return seq;
}

/** State commitment derived from the database (compare with replay.stateRoot). */
export async function dbState(c: Conn) {
  const a = await c.query<any>(
    `SELECT asset_id,supply,reserve_sats,locked_supply,creator_fee_accrued,creator_fee_claimed FROM assets ORDER BY asset_id`,
  );
  const p = await c.query<any>(`SELECT fees_sats FROM platform_ledger WHERE id=1`);
  const assets = a.rows.map((r) => ({
    asset_id: r.asset_id,
    supply: big(r.supply),
    reserve: big(r.reserve_sats),
    locked: big(r.locked_supply),
    fee_accrued: big(r.creator_fee_accrued),
    fee_claimed: big(r.creator_fee_claimed),
  }));
  return { assets, platform_fees: big(p.rows[0].fees_sats) };
}

export const dbStateRoot = (s: Awaited<ReturnType<typeof dbState>>) => sha256Hex(canonical(s));

export async function createCheckpoint(mint: Mint): Promise<number | null> {
  return mint.db.tx(async (c) => {
    const head = await c.query<any>(`SELECT size FROM audit_head WHERE id=1 FOR UPDATE`);
    const size = Number(big(head.rows[0].size));
    if (size === 0) return null;
    const existing = await c.query(`SELECT 1 FROM audit_checkpoints WHERE size=$1`, [size]);
    if (existing.rows.length) return null;
    const leaves = (await c.query<any>(`SELECT leaf_hash FROM audit_events ORDER BY seq`)).rows.map((r) => r.leaf_hash);
    const logRoot = mth(leaves);
    const state = await dbState(c);
    const stateRoot = dbStateRoot(state);
    const totals = {
      assets: state.assets.length,
      supply: state.assets.reduce((x, a) => x + a.supply, 0n).toString(),
      reserve: state.assets.reduce((x, a) => x + a.reserve, 0n).toString(),
      locked: state.assets.reduce((x, a) => x + a.locked, 0n).toString(),
      platform_fees: state.platform_fees.toString(),
    };
    const ev = finalizeEvent(
      {
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', `nutpad-checkpoint-${size}`],
          ['t', 'nutpad-checkpoint'],
        ],
        content: canonical({ size, log_root: logRoot, state_root: stateRoot, totals }),
      },
      mint.nostrSk,
    );
    await c.query(
      `INSERT INTO audit_checkpoints(size,log_root,state_root,totals,signed_event) VALUES($1,$2,$3,$4,$5)`,
      [size, logRoot, stateRoot, JSON.stringify(totals), JSON.stringify(ev)],
    );
    await enqueueNostr(c, 'checkpoint', ev, `checkpoint:${size}`);
    return size;
  });
}

export async function enqueueNostr(c: Conn, kind: string, event: { id: string }, ref: string) {
  await c.query(
    `INSERT INTO outbox(kind,payload,event_id,ref) VALUES($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING`,
    [kind, JSON.stringify(event), event.id, ref],
  );
}
