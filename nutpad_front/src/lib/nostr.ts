// Nostr identity. The app never sees an nsec except for the explicit browser-only "burner key" option.
import { generateSecretKey, getPublicKey, finalizeEvent, type EventTemplate, type Event } from 'nostr-tools/pure';
import { BunkerSigner, parseBunkerInput, createNostrConnectURI } from 'nostr-tools/nip46';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { api, API_URL, setApiToken } from './api';

export type SignerKind = 'nip07' | 'bunker' | 'burner';

export interface Signer {
  kind: SignerKind;
  pubkey: string;
  signEvent(t: EventTemplate): Promise<Event>;
  close?(): Promise<void>;
}

const LS = 'nutpad.session.v1';
interface Stored {
  kind: SignerKind;
  pubkey: string;
  token: string;
  expires_at: string;
  burnerSk?: string;
  bunker?: { clientSk: string; pointer: { pubkey: string; relays: string[]; secret: string | null } };
}

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

export const hasNip07 = () => typeof window !== 'undefined' && !!(window as any).nostr;

export async function nip07Signer(): Promise<Signer> {
  const n = (window as any).nostr;
  if (!n) throw new Error('No NIP-07 browser extension found (try Alby, nos2x, or a remote signer)');
  const pubkey: string = await n.getPublicKey();
  return { kind: 'nip07', pubkey, signEvent: (t) => n.signEvent(t) };
}

export function burnerSigner(skHex?: string): Signer {
  const sk = skHex ? hexToBytes(skHex) : generateSecretKey();
  const pubkey = getPublicKey(sk);
  const s: Signer & { sk: string } = {
    kind: 'burner',
    pubkey,
    sk: bytesToHex(sk),
    signEvent: async (t) => finalizeEvent(t, sk),
  };
  return s;
}

function wrapBunker(bs: BunkerSigner, pubkey: string): Signer {
  const s: Signer = {
    kind: 'bunker',
    pubkey,
    signEvent: async (t) => {
      try {
        return (await bs.signEvent(t)) as Event;
      } catch (e) {
        if (/timeout/i.test(String(e)))
          throw new Error(`Remote signer did not answer. Open your signer app and approve "sign_event kind ${t.kind}". If no request ever appears, log out and log in again so the signer can grant this permission, then retry.`);
        throw e;
      }
    },
    close: () => bs.close(),
  };
  liveBunker = s;
  return s;
}
let liveBunker: Signer | null = null;

/** NIP-46: paste a bunker:// URL or NIP-05 identifier (e.g. from Primal / nsec.app / Amber). */
export async function bunkerSignerFromInput(input: string): Promise<{ signer: Signer; clientSk: string; pointer: any }> {
  const pointer = await parseBunkerInput(input.trim());
  if (!pointer) throw new Error('Not a valid bunker:// URL or NIP-05 address');
  const clientSk = generateSecretKey();
  const bs = BunkerSigner.fromBunker(clientSk, pointer, { timeout: 120_000, onauth: (url) => window.open(url, '_blank', 'noopener,width=480,height=720') });
  await bs.connect();
  const pubkey = await bs.getPublicKey();
  return { signer: wrapBunker(bs, pubkey), clientSk: bytesToHex(clientSk), pointer };
}

/** NIP-46 client-initiated flow: show this URI/QR in the remote signer, then await the connection. */
export function startNostrConnect(relays = DEFAULT_RELAYS) {
  const clientSk = generateSecretKey();
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(clientSk),
    relays,
    secret,
    name: 'nutpad',
    url: window.location.origin,
    perms: ['sign_event:27235', 'sign_event:30078', 'sign_event:1', 'sign_event:10019', 'sign_event:9321'],
  });
  const abort = new AbortController();
  const done = BunkerSigner.fromURI(clientSk, uri, {}, abort.signal).then(async (bs) => {
    const pubkey = await bs.getPublicKey();
    // keep the pointer the library actually talks to (the remote signer's key), so the session can be rebuilt after a reload
    return { signer: wrapBunker(bs, pubkey), clientSk: bytesToHex(clientSk), pointer: { ...bs.bp, relays: bs.bp.relays?.length ? bs.bp.relays : relays, secret: null } };
  });
  return { uri, done, cancel: () => abort.abort() };
}

// ------------------------------------------------------------------ session

export async function loginWith(
  signer: Signer,
  extra: Partial<Stored> = {},
): Promise<{ pubkey: string; token: string }> {
  const ch = await api<{ challenge: string; url: string }>('POST', '/auth/challenge');
  const event = await signer.signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', ch.url], ['method', 'POST'], ['challenge', ch.challenge]],
    content: '',
  });
  const r = await api<{ token: string; pubkey: string; expires_at: string }>('POST', '/auth/verify', { event });
  if (r.pubkey !== signer.pubkey) throw new Error('Signer returned an unexpected pubkey');
  setApiToken(r.token);
  const stored: Stored = { kind: signer.kind, pubkey: r.pubkey, token: r.token, expires_at: r.expires_at, ...extra };
  if (signer.kind === 'burner') stored.burnerSk = (signer as any).sk;
  try {
    localStorage.setItem(LS, JSON.stringify(stored));
  } catch {
    /* ignore */
  }
  return { pubkey: r.pubkey, token: r.token };
}

export function readStoredSession(): Stored | null {
  try {
    const s = JSON.parse(localStorage.getItem(LS) ?? 'null') as Stored | null;
    if (s && new Date(s.expires_at).getTime() > Date.now()) return s;
  } catch {
    /* ignore */
  }
  return null;
}

export function clearSession() {
  setApiToken(null);
  try {
    localStorage.removeItem(LS);
  } catch {
    /* ignore */
  }
}

/** Rebuild a signer for the stored session (used when we must sign a manifest). */
export async function signerFromStored(s: Stored): Promise<Signer> {
  if (s.kind === 'burner' && s.burnerSk) return burnerSigner(s.burnerSk);
  if (s.kind === 'nip07') return nip07Signer();
  if (s.kind === 'bunker' && liveBunker && liveBunker.pubkey === s.pubkey) return liveBunker;
  if (s.kind === 'bunker' && s.bunker) {
    // the page was reloaded: reopen the NIP-46 channel with the stored client key (the signer already trusts it)
    const bs = BunkerSigner.fromBunker(hexToBytes(s.bunker.clientSk), s.bunker.pointer, { timeout: 120_000, onauth: (url) => window.open(url, '_blank', 'noopener,width=480,height=720') });
    return wrapBunker(bs, s.pubkey);
  }
  if (s.kind === 'bunker')
    throw new Error('Remote signer connection was lost. Click Logout and log in with your signer again.');
  throw new Error('Cannot restore signer, please log in again');
}

export const sessionApiHint = API_URL;
