// RFC 6962 / RFC 9162 Merkle tree with SHA-256.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

export const emptyRoot = (): string => bytesToHex(sha256(new Uint8Array()));
export const leafHash = (data: Uint8Array): string => bytesToHex(sha256(concatBytes(LEAF, data)));
const nodeHash = (l: string, r: string): string =>
  bytesToHex(sha256(concatBytes(NODE, hexToBytes(l), hexToBytes(r))));

function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Merkle tree hash over leaf hashes [lo, hi). */
export function mth(leaves: string[], lo = 0, hi = leaves.length): string {
  const n = hi - lo;
  if (n === 0) return emptyRoot();
  if (n === 1) return leaves[lo];
  const k = split(n);
  return nodeHash(mth(leaves, lo, lo + k), mth(leaves, lo + k, hi));
}

export function inclusionProof(leaves: string[], index: number, lo = 0, hi = leaves.length): string[] {
  const n = hi - lo;
  if (n <= 1) return [];
  const k = split(n);
  if (index < k) return [...inclusionProof(leaves, index, lo, lo + k), mth(leaves, lo + k, hi)];
  return [...inclusionProof(leaves, index - k, lo + k, hi), mth(leaves, lo, lo + k)];
}

export function verifyInclusion(
  leaf: string,
  index: number,
  size: number,
  path: string[],
  root: string,
): boolean {
  if (index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of path) {
    if (sn === 0) return false;
    if (fn & 1 || fn === sn) {
      r = nodeHash(p, r);
      if (!(fn & 1)) {
        while (!(fn & 1) && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && r === root;
}

function subProof(leaves: string[], m: number, lo: number, hi: number, b: boolean): string[] {
  const n = hi - lo;
  if (m === n) return b ? [] : [mth(leaves, lo, hi)];
  const k = split(n);
  if (m <= k) return [...subProof(leaves, m, lo, lo + k, b), mth(leaves, lo + k, hi)];
  return [...subProof(leaves, m - k, lo + k, hi, false), mth(leaves, lo, lo + k)];
}

export function consistencyProof(leaves: string[], first: number, second: number): string[] {
  if (first <= 0 || first > second || second > leaves.length) throw new RangeError('bad sizes');
  return subProof(leaves, first, 0, second, true);
}

export function verifyConsistency(
  first: number,
  second: number,
  proof: string[],
  firstRoot: string,
  secondRoot: string,
): boolean {
  if (first === second) return proof.length === 0 && firstRoot === secondRoot;
  if (first <= 0 || first > second) return false;
  const p = [...proof];
  if ((first & (first - 1)) === 0) p.unshift(firstRoot);
  if (p.length === 0) return false;
  let fn = first - 1;
  let sn = second - 1;
  while (fn & 1) {
    fn >>= 1;
    sn >>= 1;
  }
  let fr = p[0];
  let sr = p[0];
  for (const c of p.slice(1)) {
    if (sn === 0) return false;
    if (fn & 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (!(fn & 1)) {
        while (!(fn & 1) && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return fr === firstRoot && sr === secondRoot && sn === 0;
}
