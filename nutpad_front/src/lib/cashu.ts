// Client-side Cashu (NUT-00 BDHKE) with deterministic, seed-derived secrets.
// Derivation is HMAC-SHA256 based (nutpad scheme, NOT NUT-13 byte-compatible).
import { secp256k1 } from '@noble/curves/secp256k1.js';
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
