// Local-first Cashu wallet. The seed, counters and proofs live ONLY in this browser.
// Every mint call is a recoverable operation: it is persisted as `pending` before being
// sent and replayed with the same Idempotency-Key until the mint gives a definitive answer.
import { useSyncExternalStore } from 'react';
import { api, ApiFail, API_URL, uuid } from './api';
import {
  blindWithSecret, deriveBlinded, isLockedSecret, newSeedHex, p2pkPub, p2pkSecret, proofY, splitAmount, unblind, witnessFor,
  type Blinded, type BlindSignature, type Proof,
} from './cashu';

const LS_KEY = 'nutpad.wallet.v1';

interface Group {
  name: string;
  keysetId: string;
  field: string; // response field holding the signatures
  blinded: Blinded[];
}
interface PendingOp {
  id: string;
  key: string;
  method: 'POST';
  path: string;
  body: Record<string, unknown>; // inputs + output field names are already inside
  inputs: Proof[];
  groups: Group[];
  kind: string;
  createdAt: number;
}
export interface DepositQuote {
  quote: string;
  amount: number;
  request: string;
  expiry: number;
  createdAt: number;
}
interface WalletData {
  seed: string;
  counters: Record<string, number>;
  proofs: Proof[];
  pending: PendingOp[];
  deposits?: DepositQuote[];
  /** locked (P2PK) proofs that are not spendable yet and not tied to a sent record */
  escrow?: Proof[];
  sent?: SentNutzap[];
  received?: ReceivedNutzap[];
  /** ids of Nostr events already handled */
  seen?: string[];
}
export interface SentNutzap {
  id: string;
  to: string; // recipient nostr pubkey (hex)
  unit: string;
  amount: number;
  memo?: string;
  locktime: number;
  proofs: Proof[];
  eventId?: string;
  createdAt: number;
  state: 'open' | 'done';
}
export interface ReceivedNutzap {
  eventId: string;
  from: string;
  unit: string;
  amount: number;
  memo?: string;
  at: number;
}
export interface KeysetMeta {
  id: string;
  unit: string;
  active: boolean;
  asset_id: string | null;
}

let data: WalletData = load();
let version = 0;
const listeners = new Set<() => void>();
let keysetMeta: KeysetMeta[] = [];
const keyCache = new Map<string, Record<string, string>>();

function load(): WalletData {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable */
  }
  return fresh();
}
function fresh(): WalletData {
  return { seed: newSeedHex(), counters: {}, proofs: [], pending: [], deposits: [] };
}

function commit() {
  version++;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable — wallet keeps working in memory */
  }
  listeners.forEach((l) => l());
}
commit();

export function useWallet() {
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => version,
  );
  return {
    proofs: data.proofs,
    pending: data.pending,
    deposits: data.deposits ?? [],
    sent: data.sent ?? [],
    received: data.received ?? [],
    seed: data.seed,
    keysets: keysetMeta,
    balance: (keysetId: string) => data.proofs.filter((p) => p.id === keysetId).reduce((a, p) => a + p.amount, 0),
  };
}
export const walletSeed = () => data.seed;
export const balanceOf = (keysetId: string) => data.proofs.filter((p) => p.id === keysetId).reduce((a, p) => a + p.amount, 0);

// ------------------------------------------------------------------ mint metadata

export async function refreshKeysets(): Promise<KeysetMeta[]> {
  const r = await api<{ keysets: KeysetMeta[] }>('GET', '/v1/keysets');
  keysetMeta = r.keysets;
  commit();
  return keysetMeta;
}
export async function satKeysetId(): Promise<string> {
  if (!keysetMeta.length) await refreshKeysets();
  const k = keysetMeta.find((x) => x.unit === 'sat');
  if (!k) throw new Error('mint has no sat keyset');
  return k.id;
}
async function keysOf(id: string): Promise<Record<string, string>> {
  let k = keyCache.get(id);
  if (!k) {
    const r = await api<{ keysets: { keys: Record<string, string> }[] }>('GET', `/v1/keys/${id}`);
    k = r.keysets[0].keys;
    keyCache.set(id, k);
  }
  return k;
}

// ------------------------------------------------------------------ outputs & selection

export function newOutputs(keysetId: string, total: number | bigint): Blinded[] {
  const out: Blinded[] = [];
  let c = data.counters[keysetId] ?? 0;
  for (const amount of splitAmount(total)) out.push(deriveBlinded(data.seed, keysetId, c++, amount));
  data.counters[keysetId] = c;
  return out;
}

/** Outputs locked (NUT-11) to `lock.pub`; this wallet's own key can refund them after the locktime. */
function lockedOutputs(keysetId: string, total: number | bigint, lock: { pub: string; locktime: number }): Blinded[] {
  const refund = p2pkPub(data.seed);
  return splitAmount(total).map((amount) => blindWithSecret(keysetId, amount, p2pkSecret(lock.pub, lock.locktime, refund)));
}

export function selectProofs(keysetId: string, amount: number): Proof[] {
  const pool = data.proofs.filter((p) => p.id === keysetId).sort((a, b) => b.amount - a.amount);
  const picked: Proof[] = [];
  let sum = 0;
  for (const p of pool) {
    if (sum >= amount) break;
    picked.push(p);
    sum += p.amount;
  }
  if (sum < amount) throw new Error(`Insufficient balance: need ${amount}, have ${sum}`);
  return picked;
}
const sumP = (ps: Proof[]) => ps.reduce((a, p) => a + p.amount, 0);

// ------------------------------------------------------------------ recoverable operations

export interface OpSpec {
  kind: string;
  path: string;
  inputs: Proof[];
  groups: { name: string; keysetId: string; field: string; total: number | bigint; lock?: { pub: string; locktime: number } }[];
  extra?: Record<string, unknown>;
  /** body field name that carries inputs (or null when none) */
  inputsField?: string | null;
  key?: string;
}
export interface OpResult {
  response: any;
  proofs: Record<string, Proof[]>;
}

export async function runOp(spec: OpSpec, keep: (groupName: string) => boolean = () => true): Promise<OpResult> {
  const groups: Group[] = spec.groups.map((g) => ({
    name: g.name, keysetId: g.keysetId, field: g.field,
    blinded: !g.total ? [] : g.lock ? lockedOutputs(g.keysetId, g.total, g.lock) : newOutputs(g.keysetId, g.total),
  }));
  const body: Record<string, unknown> = { ...(spec.extra ?? {}) };
  if (spec.inputsField !== null) body[spec.inputsField ?? 'inputs'] = spec.inputs;
  for (const g of groups) {
    const f = outputsField(spec.path, g.name);
    body[f] = [...((body[f] as unknown[]) ?? []), ...g.blinded.map((b) => b.msg)];
  }
  const op: PendingOp = {
    id: uuid(), key: spec.key ?? uuid(), method: 'POST', path: spec.path, body, inputs: spec.inputs,
    groups, kind: spec.kind, createdAt: Date.now(),
  };
  // inputs leave the spendable set as soon as the op is persisted
  const spentY = new Set(spec.inputs.map((p) => p.secret));
  data.proofs = data.proofs.filter((p) => !spentY.has(p.secret));
  data.pending.push(op);
  commit();
  return settle(op, keep);
}

/** Output field name per (endpoint, group): matches the server's request shapes. */
function outputsField(path: string, group: string): string {
  if (['/v1/swap', '/v1/faucet', '/fees/claim', '/v1/mint/bolt11', '/v1/melt/bolt11'].includes(path) || path.endsWith('/claim')) return 'outputs';
  return group === 'asset' ? 'outputs_asset' : 'outputs_sat';
}

async function settle(op: PendingOp, keep: (g: string) => boolean): Promise<OpResult> {
  let response: any;
  try {
    response = await api('POST', op.path, op.body, op.key);
  } catch (e) {
    if (e instanceof ApiFail && !e.retryable) {
      // definitive refusal: nothing was spent or issued, give the inputs back
      data.proofs.push(...op.inputs.filter((p) => !isLockedSecret(p.secret)));
      data.pending = data.pending.filter((p) => p.id !== op.id);
      commit();
      await pruneSpent();
    }
    throw e; // retryable => stays pending, resumePending() will retry with the same key
  }
  if (response?.state === 'PENDING') throw new ApiFail(202, 'PENDING', 'Payment is still in flight; it will be retried automatically', true);
  const proofs: Record<string, Proof[]> = {};
  const offsets: Record<string, number> = {};
  for (const g of op.groups) {
    const all: BlindSignature[] = response[g.field] ?? [];
    const from = offsets[g.field] ?? 0;
    const sigs = all.slice(from, from + g.blinded.length);
    offsets[g.field] = from + g.blinded.length;
    if (sigs.length !== g.blinded.length) throw new Error(`mint returned ${sigs.length} signatures for ${g.blinded.length} outputs`);
    const keys = g.blinded.length ? await keysOf(g.keysetId) : {};
    proofs[g.name] = g.blinded.map((b, i) => unblind(b, sigs[i], keys));
    if (keep(g.name)) {
      // locked proofs are not spendable by this wallet; they wait in escrow until a sent record claims them
      data.proofs.push(...proofs[g.name].filter((p) => !isLockedSecret(p.secret)));
      (data.escrow ??= []).push(...proofs[g.name].filter((p) => isLockedSecret(p.secret)));
    }
  }
  data.pending = data.pending.filter((p) => p.id !== op.id);
  commit();
  return { response, proofs };
}

let resuming = false;
export async function resumePending(): Promise<void> {
  if (resuming) return;
  resuming = true;
  try {
    for (const op of [...data.pending]) {
      try {
        await settle(op, () => true);
      } catch {
        /* still pending or definitively failed; surfaced in UI */
      }
    }
  } finally {
    resuming = false;
  }
}

/** Drop proofs the mint reports as spent (e.g. after a failed op or on another device). */
export async function pruneSpent(): Promise<number> {
  const ys = data.proofs.map((p) => proofY(p.secret));
  let removed = 0;
  for (let i = 0; i < ys.length; i += 400) {
    const chunk = ys.slice(i, i + 400);
    const r = await api<{ states: { Y: string; state: string }[] }>('POST', '/v1/checkstate', { Ys: chunk }).catch(() => null);
    if (!r) return removed;
    const spent = new Set(r.states.filter((s) => s.state === 'SPENT').map((s) => s.Y));
    const before = data.proofs.length;
    data.proofs = data.proofs.filter((p) => !spent.has(proofY(p.secret)));
    removed += before - data.proofs.length;
  }
  if (removed) commit();
  return removed;
}

// ------------------------------------------------------------------ high-level actions

export async function faucet(amount: number) {
  const sat = await satKeysetId();
  return runOp({ kind: 'faucet', path: '/v1/faucet', inputs: [], inputsField: null, groups: [{ name: 'sat', keysetId: sat, field: 'signatures', total: amount }] });
}

export async function trade(assetId: string, assetKeyset: string, side: 'BUY' | 'SELL', opts: { units?: bigint; sats?: bigint }) {
  const sat = await satKeysetId();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const q = await api<any>('POST', '/trades/quote', {
      asset_id: assetId, side, ...(opts.sats !== undefined ? { sats: opts.sats.toString() } : { units: opts.units!.toString() }),
    });
    const delta = BigInt(q.delta);
    try {
      if (side === 'BUY') {
        const total = Number(q.total);
        const inputs = selectProofs(sat, total);
        return await runOp({
          kind: 'buy', path: '/trades/execute', inputs,
          extra: { asset_id: assetId, side, delta: delta.toString(), limit_sats: total.toString() },
          groups: [
            { name: 'asset', keysetId: assetKeyset, field: 'signatures_asset', total: delta },
            { name: 'sat', keysetId: sat, field: 'signatures_sat', total: sumP(inputs) - total },
          ],
        });
      }
      const inputs = selectProofs(assetKeyset, Number(delta));
      return await runOp({
        kind: 'sell', path: '/trades/execute', inputs,
        extra: { asset_id: assetId, side, delta: delta.toString(), limit_sats: q.payout },
        groups: [
          { name: 'asset', keysetId: assetKeyset, field: 'signatures_asset', total: sumP(inputs) - Number(delta) },
          { name: 'sat', keysetId: sat, field: 'signatures_sat', total: Number(q.payout) },
        ],
      });
    } catch (e) {
      lastErr = e;
      // price moved between quote and execute: re-quote and retry
      if (e instanceof ApiFail && (e.code === 'UNBALANCED' || e.code === 'SLIPPAGE') && attempt < 2) continue;
      throw e;
    }
  }
  throw lastErr;
}

// ------------------------------------------------------------------ Lightning deposit / withdraw

export async function createDeposit(amount: number): Promise<DepositQuote & { network: string }> {
  const q = await api<any>('POST', '/v1/mint/quote/bolt11', { amount: String(amount), unit: 'sat' });
  const d: DepositQuote = { quote: q.quote, amount, request: q.request, expiry: q.expiry, createdAt: Date.now() };
  data.deposits = [...(data.deposits ?? []), d];
  commit();
  return { ...d, network: q.network };
}

export const dropDeposit = (quote: string) => {
  data.deposits = (data.deposits ?? []).filter((d) => d.quote !== quote);
  commit();
};

/** Check one deposit; if it was paid, mint the ecash (recoverable and idempotent per quote). */
const settling = new Set<string>();
export async function settleDeposit(d: DepositQuote): Promise<'PAID' | 'UNPAID' | 'DONE' | 'EXPIRED'> {
  if (settling.has(d.quote)) return 'PAID';
  settling.add(d.quote);
  try {
    return await settleDepositInner(d);
  } finally {
    settling.delete(d.quote);
  }
}
async function settleDepositInner(d: DepositQuote): Promise<'PAID' | 'UNPAID' | 'DONE' | 'EXPIRED'> {
  const st = await api<{ state: string }>('GET', `/v1/mint/quote/bolt11/${d.quote}`);
  if (st.state === 'UNPAID') return 'UNPAID';
  if (st.state === 'EXPIRED') { dropDeposit(d.quote); return 'EXPIRED'; }
  if (st.state === 'ISSUED') {
    // already issued: re-run with the same deterministic outputs only if we have a pending op for it
    if (!data.pending.some((p) => p.kind === 'deposit' && (p.body as any).quote === d.quote)) { dropDeposit(d.quote); return 'DONE'; }
    return 'PAID';
  }
  const sat = await satKeysetId();
  await runOp({ kind: 'deposit', path: '/v1/mint/bolt11', inputs: [], inputsField: null, extra: { quote: d.quote }, groups: [{ name: 'sat', keysetId: sat, field: 'signatures', total: d.amount }] });
  dropDeposit(d.quote);
  return 'DONE';
}

export async function checkDeposits(): Promise<void> {
  for (const d of [...(data.deposits ?? [])]) {
    try { await settleDeposit(d); } catch { /* retried next time */ }
  }
}

export interface MeltQuote { quote: string; amount: string; fee_reserve: string; request: string; expiry: number; state: string }
export const meltQuote = (request: string) => api<MeltQuote>('POST', '/v1/melt/quote/bolt11', { request: request.trim(), unit: 'sat' });

export async function withdraw(q: MeltQuote) {
  const sat = await satKeysetId();
  const need = Number(q.amount) + Number(q.fee_reserve);
  const inputs = selectProofs(sat, need);
  const change = sumP(inputs) - need;
  return runOp({
    kind: 'withdraw', path: '/v1/melt/bolt11', inputs, extra: { quote: q.quote },
    groups: [{ name: 'sat', keysetId: sat, field: 'signatures', total: change }],
  });
}

// ------------------------------------------------------------------ transfer (cashuA-style bearer token)

export interface TokenV3 {
  token: { mint: string; proofs: Proof[] }[];
  unit: string;
  memo?: string;
}
const b64u = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

export const encodeToken = (t: TokenV3) => 'cashuA' + b64u(JSON.stringify(t));
export function decodeToken(s: string): TokenV3 {
  const m = /^cashuA([A-Za-z0-9_-]+)$/.exec(s.trim());
  if (!m) throw new Error('Not a cashuA token');
  return JSON.parse(unb64u(m[1]));
}

export async function sendToken(keysetId: string, amount: number, memo?: string): Promise<string> {
  const unit = keysetMeta.find((k) => k.id === keysetId)?.unit ?? 'sat';
  const pool = data.proofs.filter((p) => p.id === keysetId);
  // exact subset only if trivially available; otherwise swap into [amount, change]
  const inputs = selectProofs(keysetId, amount);
  const total = sumP(inputs);
  let sendProofs: Proof[];
  if (total === amount) {
    sendProofs = inputs;
    const ids = new Set(inputs.map((p) => p.secret));
    data.proofs = data.proofs.filter((p) => !ids.has(p.secret));
    commit();
  } else {
    const r = await runOp(
      {
        kind: 'send-split', path: '/v1/swap', inputs,
        groups: [
          { name: 'send', keysetId, field: 'signatures', total: amount },
          { name: 'change', keysetId, field: 'signatures', total: total - amount },
        ],
      },
      (g) => g === 'change',
    );
    sendProofs = r.proofs.send;
  }
  void pool;
  return encodeToken({ token: [{ mint: API_URL, proofs: sendProofs }], unit, memo });
}

export async function receiveToken(str: string): Promise<{ amount: number; unit: string }> {
  const t = decodeToken(str);
  const proofs = t.token.flatMap((e) => {
    if (e.mint.replace(/\/$/, '') !== API_URL) throw new Error(`Token is from a different mint (${e.mint})`);
    return e.proofs;
  });
  if (!proofs.length) throw new Error('Empty token');
  const keysetId = proofs[0].id;
  if (proofs.some((p) => p.id !== keysetId)) throw new Error('Mixed-keyset tokens are not supported');
  await runOp({
    kind: 'receive', path: '/v1/swap', inputs: proofs,
    groups: [{ name: 'in', keysetId, field: 'signatures', total: sumP(proofs) }],
  });
  return { amount: sumP(proofs), unit: t.unit };
}

// ------------------------------------------------------------------ locked ecash (NUT-11) for Nostr sends

export const walletP2pk = () => p2pkPub(data.seed);
const unitOf = (keysetId: string) => keysetMeta.find((k) => k.id === keysetId)?.unit ?? 'sat';

/** Swap proofs for outputs locked to `recipientPub`. Returns a sent record holding the locked proofs. */
export async function sendLocked(keysetId: string, amount: number, to: string, recipientPub: string, locktime: number, memo?: string): Promise<SentNutzap> {
  const inputs = selectProofs(keysetId, amount);
  const total = sumP(inputs);
  const r = await runOp({
    kind: 'nostr-send', path: '/v1/swap', inputs,
    groups: [
      { name: 'send', keysetId, field: 'signatures', total: amount, lock: { pub: recipientPub, locktime } },
      { name: 'change', keysetId, field: 'signatures', total: total - amount },
    ],
  });
  const proofs = r.proofs.send;
  const have = new Set(proofs.map((p) => p.secret));
  data.escrow = (data.escrow ?? []).filter((p) => !have.has(p.secret));
  const rec: SentNutzap = { id: uuid(), to, unit: unitOf(keysetId), amount, memo, locktime, proofs, createdAt: Date.now(), state: 'open' };
  (data.sent ??= []).unshift(rec);
  commit();
  return rec;
}
export function markPublished(id: string, eventId: string) {
  const r = data.sent?.find((s) => s.id === id);
  if (r) { r.eventId = eventId; commit(); }
}

/** Spend locked proofs that pay to this wallet's key (received nutzaps, or our own after the locktime). */
export async function redeemLocked(proofs: Proof[]): Promise<number> {
  const byKs = new Map<string, Proof[]>();
  for (const p of proofs) byKs.set(p.id, [...(byKs.get(p.id) ?? []), p]);
  let got = 0;
  for (const [keysetId, ps] of byKs) {
    const inputs = ps.map((p) => ({ ...p, witness: witnessFor(data.seed, p.secret) }));
    await runOp({ kind: 'nostr-redeem', path: '/v1/swap', inputs, groups: [{ name: 'in', keysetId, field: 'signatures', total: sumP(ps) }] });
    got += sumP(ps);
  }
  return got;
}

/** Refund a sent record whose recipient never claimed it (only works after its locktime). */
export async function refundSent(id: string): Promise<number> {
  const rec = data.sent?.find((s) => s.id === id);
  if (!rec) throw new Error('unknown record');
  if (Date.now() / 1000 < rec.locktime) throw new Error(`Locked until ${new Date(rec.locktime * 1000).toLocaleString()}`);
  const got = await redeemLocked(rec.proofs);
  rec.state = 'done';
  commit();
  return got;
}

/** Mark sent records whose proofs the mint reports as spent (claimed by the recipient or refunded). */
export async function refreshSent(): Promise<void> {
  for (const rec of data.sent ?? []) {
    if (rec.state === 'done') continue;
    const r = await api<{ states: { state: string }[] }>('POST', '/v1/checkstate', { Ys: rec.proofs.map((p) => proofY(p.secret)) }).catch(() => null);
    if (r && r.states.length && r.states.every((s) => s.state === 'SPENT')) rec.state = 'done';
  }
  commit();
}

export function rememberReceived(r: ReceivedNutzap) {
  (data.received ??= []).unshift(r);
  data.received = data.received.slice(0, 100);
  commit();
}
export const isSeen = (eventId: string) => !!data.seen?.includes(eventId);
export function markSeen(eventId: string) {
  data.seen = [...(data.seen ?? []), eventId].slice(-500);
  commit();
}

// ------------------------------------------------------------------ restore / backup

export async function restoreFromSeed(seedHex: string): Promise<{ recovered: number }> {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error('Seed must be 64 hex characters');
  const metas = await refreshKeysets();
  const next: WalletData = { seed: seedHex, counters: {}, proofs: [], pending: [], deposits: [] };
  let recovered = 0;
  const BATCH = 50;
  for (const ks of metas) {
    const keys = await keysOf(ks.id);
    let counter = 0;
    let emptyRun = 0;
    let maxFound = -1;
    while (emptyRun < 2) {
      // amount is unknown to the client: derive with amount 1, mint returns the real amount
      const cand = Array.from({ length: BATCH }, (_, i) => deriveBlinded(seedHex, ks.id, counter + i, 1));
      const r = await api<{ outputs: { B_: string; amount: number }[]; signatures: BlindSignature[] }>('POST', '/v1/restore', {
        outputs: cand.map((c) => ({ B_: c.msg.B_ })),
      });
      const byB = new Map(r.outputs.map((o, i) => [o.B_, r.signatures[i]]));
      let found = 0;
      for (const c of cand) {
        const sig = byB.get(c.msg.B_);
        if (!sig) continue;
        found++;
        maxFound = Math.max(maxFound, c.counter);
        next.proofs.push(unblind({ ...c, amount: sig.amount }, sig, keys));
      }
      emptyRun = found === 0 ? emptyRun + 1 : 0;
      counter += BATCH;
    }
    next.counters[ks.id] = maxFound + 1;
  }
  data = next;
  commit();
  recovered = data.proofs.length;
  await pruneSpent();
  return { recovered: recovered - 0 };
}

async function aesKey(pass: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 250_000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function exportBackup(pass: string): Promise<string> {
  if (pass.length < 8) throw new Error('Passphrase must be at least 8 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ ...data, pending: data.pending }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(pass, salt), plain));
  return JSON.stringify({ v: 1, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) });
}

export async function importBackup(file: string, pass: string): Promise<void> {
  const j = JSON.parse(file);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(j.iv) as BufferSource }, await aesKey(pass, fromB64(j.salt)), fromB64(j.ct) as BufferSource);
  const d = JSON.parse(new TextDecoder().decode(plain)) as WalletData;
  if (!d.seed || !Array.isArray(d.proofs)) throw new Error('Backup is malformed');
  data = d;
  commit();
  await resumePending();
  await pruneSpent();
}

export function wipeWallet() {
  data = fresh();
  commit();
}
