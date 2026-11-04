import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { hashToCurve, splitAmount } from '../src/cashu.js';

const Point = secp256k1.Point;
const N = Point.Fn.ORDER;

export interface Pending {
  amount: number;
  secret: string;
  r: bigint;
  msg: { id: string; amount: number; B_: string };
}

export function blindOutputs(keysetId: string, total: bigint): Pending[] {
  return splitAmount(total).map((amount) => {
    const secret = bytesToHex(randomBytes(32));
    const r = (BigInt('0x' + bytesToHex(randomBytes(32))) % (N - 1n)) + 1n;
    const B_ = hashToCurve(utf8ToBytes(secret)).add(Point.BASE.multiply(r)).toHex(true);
    return { amount, secret, r, msg: { id: keysetId, amount, B_ } };
  });
}

export function unblind(p: Pending[], sigs: { C_: string; amount: number }[], keys: Record<string, string>) {
  return p.map((x, i) => {
    const K = Point.fromHex(keys[String(x.amount)]);
    const C = Point.fromHex(sigs[i].C_).subtract(K.multiply(x.r)).toHex(true);
    return { id: x.msg.id, amount: x.amount, secret: x.secret, C };
  });
}

/** One blinded output for an explicit secret (e.g. a NUT-10 P2PK secret). */
export function blindWithSecret(keysetId: string, amount: number, secret: string): Pending {
  const r = (BigInt('0x' + bytesToHex(randomBytes(32))) % (N - 1n)) + 1n;
  const B_ = hashToCurve(utf8ToBytes(secret)).add(Point.BASE.multiply(r)).toHex(true);
  return { amount, secret, r, msg: { id: keysetId, amount, B_ } };
}
