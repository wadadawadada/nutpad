import { nip19 } from 'nostr-tools';

/** Public site name used in announcements. */
export const SITE = 'nutpad.fun';

/**
 * Nostr public key (npub1… or hex) of the Cashu account to tag in launch posts.
 * Set VITE_CASHU_NPUB at build time. Without it the post just says "@Cashu" as plain text,
 * because a real mention needs a real pubkey (NIP-27 `nostr:npub…` plus a `p` tag).
 */
const RAW = ((import.meta as any).env?.VITE_CASHU_NPUB as string | undefined)?.trim() ?? '';

function cashuKey(): { npub: string; hex: string } | null {
  if (!RAW) return null;
  try {
    if (RAW.startsWith('npub1')) {
      const d = nip19.decode(RAW);
      return d.type === 'npub' ? { npub: RAW, hex: d.data } : null;
    }
    if (/^[0-9a-f]{64}$/i.test(RAW)) return { npub: nip19.npubEncode(RAW.toLowerCase()), hex: RAW.toLowerCase() };
  } catch {
    /* invalid value: fall back to plain text */
  }
  return null;
}

export function launchPost(o: { ticker: string; name: string; description: string; url: string }) {
  const cashu = cashuKey();
  const content = [
    `Launched $${o.ticker} — ${o.name} on ${SITE}`,
    o.description.trim().slice(0, 300),
    cashu ? `Powered by Cashu ecash: nostr:${cashu.npub}` : 'Powered by @Cashu ecash',
    o.url, // last, so clients build the link preview card from it
  ].filter(Boolean).join('\n\n');
  const tags: string[][] = [['t', 'nutpad'], ['t', 'cashu'], ['r', o.url]];
  if (cashu) tags.push(['p', cashu.hex]);
  return { content, tags };
}
