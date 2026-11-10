// Rebuild the token list from the public log on Nostr relays, without our API.
//
// The mint publishes its audit log as signed segments (kind 30078, t=nutpad-log). We fetch them, replay every
// event with the same deterministic rules the server uses, and join the result with the creators' signed
// manifests (a manifest belongs to a token when sha256(content) equals the LAUNCH event's manifest_hash).
import { SimplePool } from 'nostr-tools/pool';
import { DATA_RELAYS } from './nostr';
import { applyEvent, emptyState } from './replay';
import { spotPriceNano } from './curve';
import { sha256Hex } from './util';

const pool = new SimplePool();
const tag = (ev: { tags: string[][] }, name: string) => ev.tags.find((t) => t[0] === name)?.[1];

export interface RelayToken {
  asset_id: string;
  name: string;
  ticker: string;
  description: string;
  creator_pubkey: string;
  supply: string;
  burned_supply: string;
  reserve_sats: string;
  price_nano: string;
  trade_count: string;
  volume_sats: string;
}
export interface RelayView {
  tokens: RelayToken[];
  events: number;
  complete: boolean;
}

export const MINT_PK_KEY = 'nutpad.mintpk';
export const knownMintPk = (): string | null => {
  try {
    const v = localStorage.getItem(MINT_PK_KEY) ?? ((import.meta as any).env?.VITE_MINT_PUBKEY as string | undefined) ?? null;
    return v && /^[0-9a-f]{64}$/.test(v) ? v : null;
  } catch {
    return null;
  }
};
export const rememberMintPk = (pk: string) => { try { localStorage.setItem(MINT_PK_KEY, pk); } catch { /* ignore */ } };

export async function loadFromRelays(mintPk: string, relays: string[] = DATA_RELAYS): Promise<RelayView> {
  const segs = await pool.querySync(relays, { kinds: [30078], authors: [mintPk], '#t': ['nutpad-log'] }, { maxWait: 9000 });
  // newest version of each segment
  const newest = new Map<string, (typeof segs)[number]>();
  for (const e of segs) {
    const d = tag(e, 'd');
    if (!d) continue;
    const cur = newest.get(d);
    if (!cur || e.created_at > cur.created_at) newest.set(d, e);
  }
  const ordered = [...newest.values()].sort((a, b) => Number(tag(a, 'from')) - Number(tag(b, 'from')));
  const state = emptyState();
  const stats = new Map<string, { trades: number; volume: bigint }>();
  const launches = new Map<string, { creator: string; manifest_hash: string }>();
  let next = 1;
  let complete = true;
  outer: for (const seg of ordered) {
    for (const line of seg.content ? seg.content.split('\n') : []) {
      const i = line.indexOf('|'), j = line.indexOf('|', i + 1);
      const seq = Number(line.slice(0, i));
      if (seq !== next) { complete = false; break outer; }   // a gap: stop, never guess
      const type = line.slice(i + 1, j);
      const payload = JSON.parse(line.slice(j + 1));
      applyEvent(state, { seq, type, payload });
      if (type === 'LAUNCH') launches.set(payload.asset_id, { creator: payload.creator, manifest_hash: payload.manifest_hash });
      if (type === 'BUY' || type === 'SELL') {
        const s = stats.get(payload.asset_id) ?? { trades: 0, volume: 0n };
        s.trades++; s.volume += BigInt(payload.gross);
        stats.set(payload.asset_id, s);
      }
      next++;
    }
  }
  const creators = [...new Set([...launches.values()].map((l) => l.creator))];
  const manifests = creators.length
    ? await pool.querySync(relays, { kinds: [30078], authors: creators, '#t': ['nutpad-manifest'] }, { maxWait: 9000 })
    : [];
  const byHash = new Map(manifests.map((m) => [sha256Hex(m.content), m]));
  const tokens: RelayToken[] = [];
  for (const [id, l] of launches) {
    const a = state.assets.get(id);
    const m = byHash.get(l.manifest_hash);
    let man: any = {};
    try { man = m ? JSON.parse(m.content) : {}; } catch { /* manifest not parseable */ }
    const st = stats.get(id) ?? { trades: 0, volume: 0n };
    tokens.push({
      asset_id: id,
      name: String(man.name ?? 'unknown'),
      ticker: String(man.ticker ?? '?'),
      description: String(man.description ?? ''),
      creator_pubkey: l.creator,
      supply: String(a?.supply ?? 0n),
      burned_supply: String(a?.burned ?? 0n),
      reserve_sats: String(a?.reserve ?? 0n),
      price_nano: String(spotPriceNano(a?.supply ?? 0n)),
      trade_count: String(st.trades),
      volume_sats: String(st.volume),
    });
  }
  return { tokens: tokens.reverse(), events: next - 1, complete };
}
