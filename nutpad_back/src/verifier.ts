// Independent read-only verifier. Uses ONLY the public HTTP API.
//   npm run verify -- https://your-api.up.railway.app
// Exit code 0 = all checks passed, 1 = violation found.
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { verifyEvent } from 'nostr-tools/pure';
import { leafHash, mth, verifyConsistency, verifyInclusion } from './merkle.js';
import { applyEvent, emptyState, stateRoot, stateTotals } from './replay.js';
import { canonical } from './util.js';

const base = (process.argv[2] ?? process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const get = async (path: string) => {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<any>;
};

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

async function main() {
  console.log(`verifying ${base}`);
  const events: any[] = [];
  let from = 1;
  let size = 0;
  let mintPubkey = '';
  for (;;) {
    const page = await get(`/audit/events?from=${from}&limit=1000`);
    size = Number(page.size);
    mintPubkey = page.mint_pubkey;
    events.push(...page.events);
    if (page.events.length === 0 || events.length >= size) break;
    from = events[events.length - 1].seq + 1;
  }
  check(events.length === size, `fetched ${events.length}/${size} events`);
  check(events.every((e, i) => e.seq === i + 1), 'sequence numbers contiguous');

  const leaves = events.map((e) => leafHash(utf8ToBytes(`${e.seq}|${e.type}|${e.payload}`)));
  check(leaves.every((l, i) => l === events[i].leaf_hash), 'leaf hashes recomputed from payloads');

  const cps = (await get('/audit/checkpoints?limit=500')).checkpoints.slice().reverse();
  const st = emptyState();
  let applied = 0;
  let replayOk = true;
  let prev: { size: number; log_root: string } | null = null;
  for (const cp of cps) {
    const sz = Number(cp.size);
    try {
      while (applied < sz) {
        const e = events[applied];
        applyEvent(st, { seq: e.seq, type: e.type, payload: JSON.parse(e.payload) });
        applied++;
      }
    } catch (err: any) {
      replayOk = false;
      check(false, `replay failed at event ${applied + 1}: ${err.message}`);
      break;
    }
    const ev = cp.signed_event;
    check(verifyEvent(ev) && ev.pubkey === mintPubkey, `checkpoint ${sz}: Nostr signature by mint key`);
    const content = JSON.parse(ev.content);
    check(canonical(content) === ev.content && content.size === sz, `checkpoint ${sz}: signed content well-formed`);
    check(mth(leaves.slice(0, sz)) === cp.log_root && content.log_root === cp.log_root, `checkpoint ${sz}: Merkle root`);
    check(stateRoot(st) === cp.state_root && content.state_root === cp.state_root, `checkpoint ${sz}: state root (reserve/supply/fees/locks)`);
    if (prev) {
      const pr = await get(`/audit/proofs/consistency?first=${prev.size}&second=${sz}`);
      check(
        verifyConsistency(prev.size, sz, pr.proof, prev.log_root, cp.log_root),
        `checkpoint ${sz}: consistency with ${prev.size} (append-only)`,
      );
    }
    prev = { size: sz, log_root: cp.log_root };
  }
  if (replayOk) {
    try {
      while (applied < events.length) {
        const e = events[applied];
        applyEvent(st, { seq: e.seq, type: e.type, payload: JSON.parse(e.payload) });
        applied++;
      }
      check(true, `full replay of ${events.length} events: all invariants hold (reserve == C(supply), fees, locks, vaults)`);
    } catch (err: any) {
      check(false, `replay failed at event ${applied + 1}: ${err.message}`);
    }
  }
  if (size > 0) {
    const p = await get(`/audit/proofs/inclusion?seq=${size}`);
    check(verifyInclusion(p.leaf_hash, size - 1, size, p.path, p.root) && p.root === mth(leaves), 'inclusion proof for latest event');
  }
  console.log('totals', JSON.stringify(stateTotals(st), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  console.log('NOTE: this verifies ledger self-consistency only. It does not prove BTC backing or absence of hidden issuance.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('verifier error:', e.message);
  process.exit(1);
});
