// NUT-10 / NUT-11 spending conditions (P2PK, SIG_INPUTS). Single pubkey, optional locktime + refund keys.
// A locked proof's secret is  ["P2PK", {"nonce": "...", "data": "<33-byte pubkey hex>", "tags": [...]}]  and is
// spent with  witness = {"signatures": ["<BIP340 sig over sha256(secret)>"]}.
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { ApiError } from './util.js';

export interface SpendingCondition {
  kind: string;
  data: string;
  tags: string[][];
}

/** Returns null for a plain secret; throws for a malformed NUT-10 secret. */
export function parseCondition(secret: string): SpendingCondition | null {
  if (!secret.startsWith('[')) return null;
  let j: unknown;
  try {
    j = JSON.parse(secret);
  } catch {
    return null; // not JSON: a plain secret that merely starts with '['
  }
  if (!Array.isArray(j) || j.length !== 2 || typeof j[0] !== 'string' || typeof j[1] !== 'object' || !j[1]) return null;
  const o = j[1] as { data?: unknown; tags?: unknown };
  if (typeof o.data !== 'string') throw new ApiError(400, 'BAD_SECRET', 'NUT-10 secret needs data');
  const tags = Array.isArray(o.tags) ? o.tags : [];
  if (!tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) throw new ApiError(400, 'BAD_SECRET', 'bad tags');
  return { kind: j[0], data: o.data, tags: tags as string[][] };
}

const isPub = (h: string) => /^0[23][0-9a-f]{64}$/.test(h);

function signatures(witness: unknown): string[] {
  let w: any = witness;
  if (typeof w === 'string') {
    try {
      w = JSON.parse(w);
    } catch {
      return [];
    }
  }
  const s = w?.signatures;
  return Array.isArray(s) ? s.filter((x) => typeof x === 'string' && /^[0-9a-f]{128}$/.test(x)) : [];
}

function signedBy(pub: string, secret: string, sigs: string[]): boolean {
  if (!isPub(pub)) return false;
  const msg = sha256(utf8ToBytes(secret));
  const x = hexToBytes(pub.slice(2));
  return sigs.some((s) => {
    try {
      return schnorr.verify(hexToBytes(s), msg, x);
    } catch {
      return false;
    }
  });
}

/** Throws unless the proof's spending condition (if any) is satisfied. `nowSec` is injected for tests. */
export function checkSpendingCondition(p: { secret: string; witness?: unknown }, nowSec = Math.floor(Date.now() / 1000)): void {
  const cond = parseCondition(p.secret);
  if (!cond) return;
  if (cond.kind !== 'P2PK') throw new ApiError(400, 'UNSUPPORTED_SECRET', `spending condition ${cond.kind} is not supported`);
  if (!isPub(cond.data)) throw new ApiError(400, 'BAD_SECRET', 'P2PK data must be a 33-byte public key');
  for (const [name] of cond.tags)
    if (!['locktime', 'refund', 'sigflag', 'n_sigs', 'pubkeys'].includes(name)) throw new ApiError(400, 'UNSUPPORTED_SECRET', `unknown tag ${name}`);
  const tag = (n: string) => cond.tags.find((t) => t[0] === n);
  if (tag('sigflag') && tag('sigflag')![1] !== 'SIG_INPUTS') throw new ApiError(400, 'UNSUPPORTED_SECRET', 'only SIG_INPUTS is supported');
  if (tag('n_sigs') || tag('pubkeys')) throw new ApiError(400, 'UNSUPPORTED_SECRET', 'multisig is not supported');
  const sigs = signatures(p.witness);
  if (signedBy(cond.data, p.secret, sigs)) return;
  const lock = Number(tag('locktime')?.[1] ?? NaN);
  if (Number.isFinite(lock) && nowSec >= lock) {
    const refund = tag('refund')?.slice(1) ?? [];
    if (refund.length === 0) return; // locktime passed and no refund key: anyone can spend
    if (refund.some((k) => signedBy(k, p.secret, sigs))) return;
  }
  throw new ApiError(400, 'P2PK_LOCKED', 'valid signature required to spend this proof');
}
