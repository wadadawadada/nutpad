// Shared with the backend (replay.ts needs the same canonical JSON and hashing).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const sha256Hex = (data: string | Uint8Array): string => bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));

/** Deterministic JSON: sorted keys, bigint as decimal string. */
export function canonical(v: unknown): string {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(o[k]))
      .join(',') +
    '}'
  );
}
