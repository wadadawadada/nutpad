// Send ecash to a Nostr identity (NIP-61 "nutzaps" with NUT-11 P2PK locks).
//
// Receiver: publishes a kind 10019 event naming a wallet pubkey (derived from the wallet seed) and our mint.
// Sender:   swaps proofs into outputs locked to that pubkey, then publishes a kind 9321 event carrying them.
// The proofs are useless without the receiver's key, so a public event leaks nothing spendable. If the receiver
// never claims, the sender's own wallet key can take them back after the locktime.
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import { API_URL } from './api';
import { lockInfo, type Proof } from './cashu';
import { DATA_RELAYS as DEFAULT_RELAYS, type Signer } from './nostr';
import {
  isSeen, markPublished, markSeen, redeemLocked, rememberReceived, sendLocked, walletP2pk, type SentNutzap,
} from './wallet';

export const LOCK_SECONDS = 7 * 24 * 3600;
const KIND_NUTZAP = 9321;
const KIND_INFO = 10019;
const norm = (u: string) => u.replace(/\/+$/, '').toLowerCase();
const xonly = (pub: string) => pub.slice(-64).toLowerCase();

let pool: SimplePool | null = null;
const getPool = () => (pool ??= new SimplePool());

/** npub / hex / name@domain (NIP-05) → hex pubkey. */
export async function resolveRecipient(input: string): Promise<string> {
  const s = input.trim().replace(/^nostr:/, '');
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  if (s.startsWith('npub1')) {
    const d = nip19.decode(s);
    if (d.type !== 'npub') throw new Error('Not an npub');
    return d.data;
  }
  const m = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(s);
  if (m) {
    const r = await fetch(`https://${m[2]}/.well-known/nostr.json?name=${encodeURIComponent(m[1])}`).catch(() => null);
    const j = r?.ok ? await r.json().catch(() => null) : null;
    const hex = j?.names?.[m[1].toLowerCase()];
    if (typeof hex === 'string' && /^[0-9a-f]{64}$/i.test(hex)) return hex.toLowerCase();
    throw new Error(`Could not resolve ${s}`);
  }
  throw new Error('Enter an npub, a hex pubkey or a name@domain address');
}

export interface ReceiveInfo {
  pubkey: string; // 33-byte P2PK key the sender locks to
  relays: string[];
  mints: string[];
  eventId: string;
}

function parseInfo(ev: Event): ReceiveInfo | null {
  const pubkey = ev.tags.find((t) => t[0] === 'pubkey')?.[1];
  if (!pubkey || !/^0[23][0-9a-f]{64}$/.test(pubkey)) return null;
  return {
    pubkey,
    relays: ev.tags.filter((t) => t[0] === 'relay' && t[1]).map((t) => t[1]),
    mints: ev.tags.filter((t) => t[0] === 'mint' && t[1]).map((t) => t[1]),
    eventId: ev.id,
  };
}

export async function fetchReceiveInfo(hex: string): Promise<ReceiveInfo | null> {
  const ev = await getPool().get(DEFAULT_RELAYS, { kinds: [KIND_INFO], authors: [hex] }, { maxWait: 5000 }).catch(() => null);
  return ev ? parseInfo(ev) : null;
}

async function publish(ev: Event, relays: string[]): Promise<void> {
  const targets = [...new Set([...relays, ...DEFAULT_RELAYS])];
  const results = getPool().publish(targets, ev);
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000));
  try {
    await Promise.race([Promise.any(results), timeout]);
  } catch {
    throw new Error('No Nostr relay accepted the message. Your tokens are safe: use "Publish again" in the sent list.');
  }
}

/** Tell senders where to lock ecash for you. Needs one signature. */
export async function enableReceiving(signer: Signer): Promise<void> {
  const ev = await signer.signEvent({
    kind: KIND_INFO,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ...DEFAULT_RELAYS.map((r) => ['relay', r]),
      ['mint', API_URL, 'sat'],
      ['pubkey', walletP2pk()],
    ],
    content: '',
  });
  await publish(ev, []);
}

function nutzapTemplate(rec: SentNutzap) {
  return {
    kind: KIND_NUTZAP,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ...rec.proofs.map((p) => ['proof', JSON.stringify(p)]),
      ['u', API_URL],
      ['unit', rec.unit],
      ['p', rec.to],
      ['t', 'nutpad'],
    ],
    content: rec.memo ?? '',
  };
}

export async function publishSent(signer: Signer, rec: SentNutzap, relays: string[] = []): Promise<void> {
  const ev = await signer.signEvent(nutzapTemplate(rec));
  await publish(ev, relays);
  markPublished(rec.id, ev.id);
}

export async function sendNutzap(o: { signer: Signer; keysetId: string; amount: number; to: string; memo?: string }): Promise<SentNutzap> {
  const hex = await resolveRecipient(o.to);
  const info = await fetchReceiveInfo(hex);
  if (!info) throw new Error('This Nostr user has not enabled receiving in nutpad yet. Ask them to open Wallet → Receive on Nostr.');
  if (!info.mints.some((m) => norm(m) === norm(API_URL))) throw new Error('This user receives ecash on a different mint.');
  const rec = await sendLocked(o.keysetId, o.amount, hex, info.pubkey, Math.floor(Date.now() / 1000) + LOCK_SECONDS, o.memo);
  await publishSent(o.signer, rec, info.relays);
  return rec;
}

/** Fetch nutzaps addressed to `me` and redeem the ones locked to this wallet. Returns sats-equivalent received. */
export async function receiveNutzaps(me: string): Promise<{ amount: number; unit: string }[]> {
  const mine = xonly(walletP2pk());
  const events = await getPool().querySync(DEFAULT_RELAYS, { kinds: [KIND_NUTZAP], '#p': [me], limit: 100 }, { maxWait: 6000 });
  const got: { amount: number; unit: string }[] = [];
  for (const ev of events.sort((a, b) => a.created_at - b.created_at)) {
    if (isSeen(ev.id)) continue;
    const u = ev.tags.find((t) => t[0] === 'u')?.[1];
    if (!u || norm(u) !== norm(API_URL)) { markSeen(ev.id); continue; }
    const proofs: Proof[] = [];
    for (const t of ev.tags) {
      if (t[0] !== 'proof') continue;
      try {
        const p = JSON.parse(t[1]);
        if (p && typeof p.secret === 'string' && typeof p.C === 'string' && typeof p.id === 'string' && Number.isInteger(p.amount)) proofs.push({ id: p.id, amount: p.amount, secret: p.secret, C: p.C });
      } catch { /* skip */ }
    }
    // only proofs locked to this wallet's key are ours
    const ours = proofs.filter((p) => { const l = lockInfo(p.secret); return !!l && xonly(l.data) === mine; });
    if (ours.length === 0 || ours.length !== proofs.length) { markSeen(ev.id); continue; }
    try {
      const amount = await redeemLocked(ours);
      const unit = ev.tags.find((t) => t[0] === 'unit')?.[1] ?? 'sat';
      rememberReceived({ eventId: ev.id, from: ev.pubkey, unit, amount, memo: ev.content || undefined, at: Date.now() });
      markSeen(ev.id);
      got.push({ amount, unit });
    } catch (e: any) {
      // already spent / invalid: nothing more to do with this event. Network errors are retried next poll.
      if (e?.retryable === false || /ALREADY_SPENT|P2PK|INVALID/i.test(String(e?.code ?? e?.message))) markSeen(ev.id);
    }
  }
  return got;
}
