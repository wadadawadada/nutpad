import { useEffect, useState } from 'react';
import { SimplePool } from 'nostr-tools/pool';
import { DEFAULT_RELAYS } from './nostr';

/** Nostr profile (kind 0) name lookup with a small localStorage cache. */
const TTL = 6 * 3600_000;
const KEY = 'nutpad.profiles';
const mem = new Map<string, { name: string | null; at: number }>();
const inflight = new Map<string, Promise<string | null>>();
let pool: SimplePool | null = null;

function load() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    for (const [k, v] of Object.entries<any>(o)) mem.set(k, v);
  } catch { /* no storage */ }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(mem))); } catch { /* ignore */ }
}
load();

export function fetchProfileName(pubkey: string): Promise<string | null> {
  const hit = mem.get(pubkey);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.name);
  let p = inflight.get(pubkey);
  if (!p) {
    pool ??= new SimplePool();
    p = pool
      .get(DEFAULT_RELAYS, { kinds: [0], authors: [pubkey] }, { maxWait: 4000 })
      .then((ev) => {
        let name: string | null = null;
        if (ev) {
          try {
            const m = JSON.parse(ev.content);
            name = String(m.display_name || m.displayName || m.name || '').trim().slice(0, 40) || null;
          } catch { /* bad profile */ }
        }
        mem.set(pubkey, { name, at: Date.now() });
        save();
        return name;
      })
      .catch(() => null)
      .finally(() => inflight.delete(pubkey));
    inflight.set(pubkey, p);
  }
  return p;
}

/** The profile name of `pubkey` (null until known or if there is none). */
export function useProfileName(pubkey: string | null | undefined): string | null {
  const [name, setName] = useState<string | null>(pubkey ? mem.get(pubkey)?.name ?? null : null);
  useEffect(() => {
    if (!pubkey) { setName(null); return; }
    let live = true;
    setName(mem.get(pubkey)?.name ?? null);
    fetchProfileName(pubkey).then((n) => { if (live && n) setName(n); });
    return () => { live = false; };
  }, [pubkey]);
  return name;
}
