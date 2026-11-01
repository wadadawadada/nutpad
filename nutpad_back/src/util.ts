import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public retryable = false,
  ) {
    super(message ?? code);
  }
}

export const sha256Hex = (data: string | Uint8Array): string =>
  bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));

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

export const isHex = (s: unknown, len?: number): s is string =>
  typeof s === 'string' && /^[0-9a-f]*$/.test(s) && (len === undefined || s.length === len);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** BigInt-safe JSON for HTTP responses. */
export const jsonSafe = <T>(v: T): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
