// Client-side Cashu (NUT-00 BDHKE) with deterministic, seed-derived secrets.
// Derivation is HMAC-SHA256 based (nutpad scheme, NOT NUT-13 byte-compatible).
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const Point = secp256k1.Point;
const N = Point.Fn.ORDER;
const DOMAIN = utf8ToBytes('Secp256k1_HashToCurve_Cashu_');

export interface Proof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  witness?: string;
}
export interface BlindedMessage {
  id: string;
  amount: number;
  B_: string;
}
export interface BlindSignature {
  id: string;
  amount: number;
  C_: string;
}
export interface Blinded {
  amount: number;
  secret: string;
  r: string; // hex scalar
  counter: number;
  msg: BlindedMessage;
}

export function hashToCurve(secret: Uint8Array) {
  const msgHash = sha256(concatBytes(DOMAIN, secret));
  for (let counter = 0; counter < 65536; counter++) {
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, counter, true);
    try {
      return Point.fromHex('02' + bytesToHex(sha256(concatBytes(msgHash, c))));
    } catch {
      /* next */
    }
  }
  throw new Error('hashToCurve failed');
}

export const proofY = (secret: string) => hashToCurve(utf8ToBytes(secret)).toHex(true);

const scalar = (b: Uint8Array) => (BigInt('0x' + bytesToHex(b)) % (N - 1n)) + 1n;

export function deriveBlinded(seedHex: string, keysetId: string, counter: number, amount: number): Blinded {
  const seed = hexToBytes(seedHex);
  const secret = bytesToHex(hmac(sha256, seed, utf8ToBytes(`nutpad/secret/${keysetId}/${counter}`)));
  const r = scalar(hmac(sha256, seed, utf8ToBytes(`nutpad/r/${keysetId}/${counter}`)));
  const B_ = hashToCurve(utf8ToBytes(secret)).add(Point.BASE.multiply(r)).toHex(true);
  return { amount, secret, r: r.toString(16).padStart(64, '0'), counter, msg: { id: keysetId, amount, B_ } };
}

export function unblind(b: Blinded, sig: BlindSignature, keys: Record<string, string>): Proof {
  const K = Point.fromHex(keys[String(b.amount)]);
  const C = Point.fromHex(sig.C_).subtract(K.multiply(BigInt('0x' + b.r))).toHex(true);
  return { id: b.msg.id, amount: b.amount, secret: b.secret, C };
}

export function splitAmount(n: bigint | number): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  for (let i = 24; i >= 0; i--) {
    const p = 1n << BigInt(i);
    while (v >= p) {
      out.push(2 ** i);
      v -= p;
    }
  }
  if (v !== 0n) throw new Error('amount out of range');
  return out.reverse();
}

export const newSeedHex = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

// ------------------------------------------------------------------ NUT-10 / NUT-11 (P2PK)

/** Wallet key used to receive locked ecash. Derived from the wallet seed, so a restored wallet gets it back. */
const p2pkSk = (seedHex: string): Uint8Array =>
  hexToBytes(scalar(hmac(sha256, hexToBytes(seedHex), utf8ToBytes('nutpad/p2pk/v1'))).toString(16).padStart(64, '0'));
export const p2pkPub = (seedHex: string) => '02' + bytesToHex(schnorr.getPublicKey(p2pkSk(seedHex)));

/** Plain secrets are hex; a NUT-10 secret is a JSON array. */
export const isLockedSecret = (secret: string) => secret.startsWith('[');

export function p2pkSecret(pub: string, locktime: number, refundPub: string): string {
  return JSON.stringify(['P2PK', { nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))), data: pub, tags: [['locktime', String(locktime)], ['refund', refundPub]] }]);
}

/** The pubkey a locked secret pays to, plus its refund terms (null for plain secrets). */
export function lockInfo(secret: string): { data: string; locktime: number | null; refund: string[] } | null {
  if (!isLockedSecret(secret)) return null;
  try {
    const [kind, o] = JSON.parse(secret);
    if (kind !== 'P2PK' || typeof o?.data !== 'string') return null;
    const tags: string[][] = o.tags ?? [];
    const lt = tags.find((t) => t[0] === 'locktime');
    return { data: o.data, locktime: lt ? Number(lt[1]) : null, refund: tags.find((t) => t[0] === 'refund')?.slice(1) ?? [] };
  } catch {
    return null;
  }
}

/** NUT-11 witness for a proof locked to this wallet's key (BIP340 signature over sha256(secret)). */
export const witnessFor = (seedHex: string, secret: string): string =>
  JSON.stringify({ signatures: [bytesToHex(schnorr.sign(sha256(utf8ToBytes(secret)), p2pkSk(seedHex)))] });

export function blindWithSecret(keysetId: string, amount: number, secret: string): Blinded {
  const r = scalar(crypto.getRandomValues(new Uint8Array(32)));
  const B_ = hashToCurve(utf8ToBytes(secret)).add(Point.BASE.multiply(r)).toHex(true);
  return { amount, secret, r: r.toString(16).padStart(64, '0'), counter: -1, msg: { id: keysetId, amount, B_ } };
}
