import { nip19 } from 'nostr-tools';

export const fmt = (n: bigint | number | string) => {
  const s = BigInt(n).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

/** price_nano (sats * 1e9 per token) -> readable "0.001000" sats */
export function fmtPrice(nano: bigint | number | string): string {
  const v = BigInt(nano);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').slice(0, 6);
  return `${whole}.${frac}`;
}

export const shortKey = (hex: string) => {
  try {
    const n = nip19.npubEncode(hex);
    return n.slice(0, 10) + '…' + n.slice(-6);
  } catch {
    return hex.slice(0, 8) + '…';
  }
};

export const ago = (iso: string) => {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export const parsePubkey = (input: string): string | null => {
  const v = input.trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  try {
    const d = nip19.decode(v);
    if (d.type === 'npub') return d.data;
    if (d.type === 'nprofile') return d.data.pubkey;
  } catch {
    /* not bech32 */
  }
  return null;
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
