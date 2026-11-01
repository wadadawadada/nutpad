// Background jobs: durable Nostr outbox delivery + audit checkpoints.
import WebSocket from 'ws';
import { config } from './config.js';
import { big } from './db.js';
import { createCheckpoint } from './audit.js';
import type { Mint } from './mint.js';
import { reconcileAll } from './lightning.js';

function publishTo(relay: string, event: { id: string }, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let ws: WebSocket;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(relay);
      ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
      ws.on('message', (data) => {
        try {
          const m = JSON.parse(data.toString());
          if (m[0] === 'OK' && m[1] === event.id) finish(m[2] === true || /duplicate/i.test(String(m[3] ?? '')));
        } catch {
          /* ignore */
        }
      });
      ws.on('error', () => finish(false));
      ws.on('close', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

export async function deliverOutbox(mint: Mint): Promise<number> {
  if (config.relays.length === 0) return 0;
  const due = await mint.db.query<any>(
    `SELECT id,kind,payload,event_id,attempt_count,ref FROM outbox
     WHERE delivery_state<>'PUBLISHED' AND next_attempt_at<=now() ORDER BY id LIMIT 20`,
  );
  let sent = 0;
  for (const row of due.rows) {
    const results = await Promise.all(config.relays.map((r) => publishTo(r, row.payload)));
    const ok = results.some(Boolean);
    const attempts = Number(big(row.attempt_count)) + 1;
    if (ok) {
      sent++;
      await mint.db.query(`UPDATE outbox SET delivery_state='PUBLISHED', attempt_count=$2, last_error=NULL WHERE id=$1`, [row.id, attempts]);
      if (row.kind === 'manifest' && row.ref?.startsWith('asset:'))
        await mint.db.query(`UPDATE assets SET announcement_state='PUBLISHED' WHERE asset_id=$1`, [row.ref.slice(6)]);
    } else {
      const backoff = Math.min(2 ** attempts * 5, 3600);
      await mint.db.query(
        `UPDATE outbox SET delivery_state='RETRYING', attempt_count=$2, last_error='no relay accepted',
         next_attempt_at=now() + ($3 || ' seconds')::interval WHERE id=$1`,
        [row.id, attempts, String(backoff)],
      );
      if (row.kind === 'manifest' && row.ref?.startsWith('asset:'))
        await mint.db.query(`UPDATE assets SET announcement_state='RETRYING' WHERE asset_id=$1`, [row.ref.slice(6)]);
    }
  }
  return sent;
}

export function startWorker(mint: Mint): () => void {
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await createCheckpoint(mint);
      await reconcileAll(mint);
      await deliverOutbox(mint);
    } catch (e) {
      console.error('[worker]', e);
    } finally {
      busy = false;
    }
  };
  const t = setInterval(tick, Math.min(config.checkpointIntervalMs, 15_000));
  void tick();
  return () => {
    stopped = true;
    clearInterval(t);
  };
}
