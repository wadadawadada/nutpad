import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { nip19 } from 'nostr-tools';
import { api, setApiToken } from './api';
import {
  bunkerSignerFromInput, burnerSigner, clearSession, loginWith, nip07Signer, readStoredSession,
  signerFromStored, startNostrConnect, type Signer,
} from './nostr';

interface AuthCtx {
  pubkey: string | null;
  npub: string | null;
  kind: string | null;
  loginNip07(): Promise<void>;
  loginBunker(input: string): Promise<void>;
  loginBurner(): Promise<void>;
  startConnect(): ReturnType<typeof startNostrConnect>;
  finishConnect(r: { signer: Signer; clientSk: string; pointer: any }): Promise<void>;
  logout(): Promise<void>;
  getSigner(): Promise<Signer>;
}

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);

  useEffect(() => {
    const s = readStoredSession();
    if (!s) return;
    setApiToken(s.token);
    api('GET', '/auth/session')
      .then(() => {
        setPubkey(s.pubkey);
        setKind(s.kind);
      })
      .catch(() => clearSession());
  }, []);

  const done = useCallback((r: { pubkey: string }, k: string) => {
    setPubkey(r.pubkey);
    setKind(k);
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      pubkey,
      npub: pubkey ? nip19.npubEncode(pubkey) : null,
      kind,
      async loginNip07() {
        const s = await nip07Signer();
        done(await loginWith(s), 'nip07');
      },
      async loginBunker(input) {
        const b = await bunkerSignerFromInput(input);
        done(await loginWith(b.signer, { bunker: { clientSk: b.clientSk, pointer: b.pointer } }), 'bunker');
      },
      async loginBurner() {
        const s = burnerSigner();
        done(await loginWith(s), 'burner');
      },
      startConnect: () => startNostrConnect(),
      async finishConnect(b) {
        done(await loginWith(b.signer, { bunker: { clientSk: b.clientSk, pointer: b.pointer } }), 'bunker');
      },
      async logout() {
        await api('POST', '/auth/logout').catch(() => {});
        clearSession();
        setPubkey(null);
        setKind(null);
      },
      async getSigner() {
        const s = readStoredSession();
        if (!s) throw new Error('Please log in with Nostr first');
        return signerFromStored(s);
      },
    }),
    [pubkey, kind, done],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
