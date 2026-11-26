import { useEffect, useState } from 'react';
import { SimplePool } from 'nostr-tools/pool';
import { DEFAULT_RELAYS } from './nostr';

/** Nostr profile (kind 0) lookup with a small localStorage cache. */
export interface Profile {
  name: string | null;
  picture: string | null;
  about: string | null;
}
const TTL = 6 * 3600_000;
const KEY = 'nutpad.profiles.v2';
const mem = new Map<string, Profile & { at: number }>();
const inflight = new Map<string, Promise<Profile>>();
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

const EMPTY: Profile = { name: null, picture: null, about: null };
const clean = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
/** Only https images are shown; anything else could leak the visitor's IP to arbitrary hosts or run as a data URL. */
const safeUrl = (v: unknown) => { const s = clean(v, 500); return s && /^https:\/\//i.test(s) ? s : null; };

export function fetchProfile(pubkey: string): Promise<Profile> {
  const hit = mem.get(pubkey);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit);
  let p = inflight.get(pubkey);
  if (!p) {
    pool ??= new SimplePool();
    p = pool
      .get(DEFAULT_RELAYS, { kinds: [0], authors: [pubkey] }, { maxWait: 4000 })
      .then((ev) => {
        let prof: Profile = EMPTY;
        if (ev) {
          try {
            const m = JSON.parse(ev.content);
            prof = {
              name: clean(m.display_name || m.displayName || m.name, 40),
              picture: safeUrl(m.picture),
              about: clean(m.about, 280),
            };
          } catch { /* bad profile */ }
        }
        mem.set(pubkey, { ...prof, at: Date.now() });
        save();
        return prof;
      })
      .catch(() => EMPTY)
      .finally(() => inflight.delete(pubkey));
    inflight.set(pubkey, p);
  }
  return p;
}

export const fetchProfileName = (pubkey: string) => fetchProfile(pubkey).then((p) => p.name);

/** The profile of `pubkey` (fields are null until known or if there is none). */
export function useProfile(pubkey: string | null | undefined): Profile {
  const [prof, setProf] = useState<Profile>(pubkey ? mem.get(pubkey) ?? EMPTY : EMPTY);
  useEffect(() => {
    if (!pubkey) { setProf(EMPTY); return; }
    let live = true;
    setProf(mem.get(pubkey) ?? EMPTY);
    fetchProfile(pubkey).then((p) => { if (live && (p.name || p.picture || p.about)) setProf(p); });
    return () => { live = false; };
  }, [pubkey]);
  return prof;
}

/** The profile name of `pubkey` (null until known or if there is none). */
export const useProfileName = (pubkey: string | null | undefined): string | null => useProfile(pubkey).name;
