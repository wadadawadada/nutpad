// Publishes the audit log to Nostr relays so anyone can rebuild and verify the state without our server.
//
// The log is cut into fixed segments of SEGMENT events. Segment k is a parameterized replaceable event
// (kind 30078, d = nutpad-log-k) signed by the mint key whose content is one line per audit event:
//   <seq>|<type>|<canonical payload>
// i.e. exactly the leaf data of the Merkle tree, so a reader can recompute every leaf hash, the log root
// and the state, and compare them with the signed checkpoints. A still-open segment is re-published
// (same d tag, newer created_at) as it grows; closed segments are published once.
import { finalizeEvent } from 'nostr-tools/pure';
import { big } from './db.js';
import { config } from './config.js';
import { enqueueNostr, leafData } from './audit.js';
import type { Mint } from './mint.js';

export const SEGMENT = 40;
export const LOG_KIND = 30078;
export const LOG_TAG = 'nutpad-log';
const META = 'log_enq_seq';

export const segmentOf = (seq: number) => Math.floor((seq - 1) / SEGMENT) + 1;

export async function buildSegment(mint: Mint, k: number, upTo: number) {
  const from = (k - 1) * SEGMENT + 1;
  const to = Math.min(k * SEGMENT, upTo);
  const rows = (await mint.db.query<any>(`SELECT seq,event_type,payload FROM audit_events WHERE seq BETWEEN $1 AND $2 ORDER BY seq`, [from, to])).rows;
  const content = rows.map((r) => leafData(r.seq, r.event_type, r.payload)).join('\n');
  return finalizeEvent(
    {
      kind: LOG_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', `${LOG_TAG}-${k}`], ['t', LOG_TAG], ['from', String(from)], ['to', String(to)]],
      content,
    },
    mint.nostrSk,
  );
}

/** Queue segments that changed since the last call. Cheap: nothing happens when the log has not grown. */
export async function enqueueLogSegments(mint: Mint): Promise<number> {
  if (config.relays.length === 0) return 0;
  const head = Number(big((await mint.db.query<any>(`SELECT size FROM audit_head WHERE id=1`)).rows[0].size));
  const last = Number((await mint.db.query<any>(`SELECT value FROM meta WHERE key=$1`, [META])).rows[0]?.value ?? 0);
  if (head <= last) return 0;
  let n = 0;
  for (let k = segmentOf(last + 1); k <= segmentOf(head); k++) {
    const ev = await buildSegment(mint, k, head);
    await mint.db.tx(async (c) => {
      await enqueueNostr(c, 'log', ev, `log:${k}`);
    });
    n++;
  }
  await mint.db.query(`INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [META, String(head)]);
  return n;
}
