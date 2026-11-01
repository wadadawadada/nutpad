// Cashu BDHKE (NUT-00) primitives on secp256k1.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const Point = secp256k1.Point;
const N = Point.Fn.ORDER;

export const MAX_AMOUNT_EXP = 24; // keys for 2^0 .. 2^24
export const AMOUNTS = Array.from({ length: MAX_AMOUNT_EXP + 1 }, (_, i) => 2 ** i);

const DOMAIN = utf8ToBytes('Secp256k1_HashToCurve_Cashu_');

export function hashToCurve(secret: Uint8Array) {
  const msgHash = sha256(concatBytes(DOMAIN, secret));
  for (let counter = 0; counter < 65536; counter++) {
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, counter, true);
    const h = sha256(concatBytes(msgHash, c));
    try {
      return Point.fromHex('02' + bytesToHex(h));
    } catch {
      /* not on curve, try next */
    }
  }
  throw new Error('hashToCurve failed');
}

const toScalar = (b: Uint8Array): bigint => BigInt('0x' + bytesToHex(b)) % N || 1n;

/** Mint private key for (master seed, keyset scope, amount). */
export function deriveKey(seed: Uint8Array, scope: string, amount: number): bigint {
  return toScalar(hmac(sha256, seed, utf8ToBytes(`nutpad/key/${scope}/${amount}`)));
}

export interface Keyset {
  id: string;
  unit: string;
  keys: Record<string, string>; // amount -> compressed pubkey hex
}

export function keysetFor(seed: Uint8Array, scope: string, unit: string): Keyset {
  const keys: Record<string, string> = {};
  for (const a of AMOUNTS) keys[String(a)] = Point.BASE.multiply(deriveKey(seed, scope, a)).toHex(true);
  const concat = concatBytes(...AMOUNTS.map((a) => hexToBytes(keys[String(a)])));
  const id = '00' + bytesToHex(sha256(concat)).slice(0, 14);
  return { id, unit, keys };
}

export function signBlinded(seed: Uint8Array, scope: string, amount: number, B_: string): string {
  const k = deriveKey(seed, scope, amount);
  return Point.fromHex(B_).multiply(k).toHex(true);
}

export function verifyProof(seed: Uint8Array, scope: string, amount: number, secret: string, C: string): boolean {
  try {
    const k = deriveKey(seed, scope, amount);
    const Y = hashToCurve(utf8ToBytes(secret));
    return Y.multiply(k).equals(Point.fromHex(C));
  } catch {
    return false;
  }
}

export const proofY = (secret: string): string => hashToCurve(utf8ToBytes(secret)).toHex(true);

export function isValidPoint(hex: string): boolean {
  try {
    Point.fromHex(hex);
    return true;
  } catch {
    return false;
  }
}

/** Binary decomposition of an integer into power-of-two amounts (ascending). */
export function splitAmount(n: bigint | number): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  for (let i = MAX_AMOUNT_EXP; i >= 0; i--) {
    const p = 1n << BigInt(i);
    while (v >= p) {
      out.push(2 ** i);
      v -= p;
    }
  }
  if (v !== 0n) throw new Error('amount invalid');
  return out.reverse();
}
