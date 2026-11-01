// Lightning backend over Nostr Wallet Connect (NIP-47): the mint uses YOUR existing Lightning wallet
// (Mutiny/Alby Hub/any NIP-47 wallet) to create invoices, check them, pay, and read the balance.
import WebSocket from 'ws';
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { hexToBytes } from '@noble/hashes/utils.js';
import { decodeBolt11, type Invoice, type LnBackend, type LnNetwork, type PayResult } from './ln.js';

export interface NwcConnection {
  walletPubkey: string;
  relays: string[];
  secret: string;
}

export function parseNwcUrl(url: string): NwcConnection {
  const m = /^nostr\+walletconnect:\/\/([0-9a-f]{64})\?(.+)$/i.exec(url.trim().replace('nostrwalletconnect://', 'nostr+walletconnect://'));
  if (!m) throw new Error('NWC_URL must look like nostr+walletconnect://<pubkey>?relay=wss://…&secret=<hex>');
  const q = new URLSearchParams(m[2]);
  const relays = q.getAll('relay').filter(Boolean);
  const secret = q.get('secret') ?? '';
  if (!relays.length) throw new Error('NWC_URL has no relay parameter');
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('NWC_URL secret must be 64 hex chars');
  return { walletPubkey: m[1].toLowerCase(), relays, secret: secret.toLowerCase() };
}

class NwcError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export class NwcBackend implements LnBackend {
  name = 'nwc';
  private sk: Uint8Array;
  private pk: string;
  private enc: 'nip44_v2' | 'nip04' | null = null;

  constructor(private conn: NwcConnection, public network: LnNetwork, private timeoutMs = 30_000) {
    this.sk = hexToBytes(conn.secret);
    this.pk = getPublicKey(this.sk);
  }

  // ---------------------------------------------------------------- transport
  private open(): Promise<WebSocket> {
    const relay = this.conn.relays[0];
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relay);
      const t = setTimeout(() => { ws.terminate(); reject(new Error('nwc: relay connect timeout')); }, 10_000);
      ws.once('open', () => { clearTimeout(t); resolve(ws); });
      ws.once('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  private async encryption(): Promise<'nip44_v2' | 'nip04'> {
    if (this.enc) return this.enc;
    const ws = await this.open();
    try {
      const info = await new Promise<Event | null>((resolve) => {
        const sub = 'info' + Math.random().toString(36).slice(2, 8);
        const t = setTimeout(() => resolve(null), 6000);
        ws.on('message', (d) => {
          try {
            const m = JSON.parse(d.toString());
            if (m[0] === 'EVENT' && m[1] === sub) { clearTimeout(t); resolve(m[2]); }
            if (m[0] === 'EOSE' && m[1] === sub) { clearTimeout(t); resolve(null); }
          } catch { /* ignore */ }
        });
        ws.send(JSON.stringify(['REQ', sub, { kinds: [13194], authors: [this.conn.walletPubkey], limit: 1 }]));
      });
      const tag = info?.tags.find((t) => t[0] === 'encryption')?.[1] ?? '';
      this.enc = tag.split(' ').includes('nip44_v2') ? 'nip44_v2' : 'nip04';
    } finally {
      ws.close();
    }
    return this.enc;
  }

  private encrypt(text: string, mode: 'nip44_v2' | 'nip04') {
    return mode === 'nip44_v2'
      ? nip44.encrypt(text, nip44.getConversationKey(this.sk, this.conn.walletPubkey))
      : nip04.encrypt(this.sk, this.conn.walletPubkey, text);
  }
  private decrypt(text: string, mode: 'nip44_v2' | 'nip04') {
    return mode === 'nip44_v2'
      ? nip44.decrypt(text, nip44.getConversationKey(this.sk, this.conn.walletPubkey))
      : nip04.decrypt(this.sk, this.conn.walletPubkey, text);
  }

  /** One request/response round trip. Throws NwcError for wallet errors, Error on timeout/transport. */
  private async request<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
    const mode = await this.encryption();
    const ws = await this.open();
    try {
      const reqEvent = finalizeEvent(
        {
          kind: 23194,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', this.conn.walletPubkey], ...(mode === 'nip44_v2' ? [['encryption', 'nip44_v2']] : [])],
          content: this.encrypt(JSON.stringify({ method, params }), mode),
        },
        this.sk,
      );
      const result = await new Promise<any>((resolve, reject) => {
        const sub = 'r' + Math.random().toString(36).slice(2, 10);
        const t = setTimeout(() => reject(new Error(`nwc: no response to ${method} within ${this.timeoutMs}ms`)), this.timeoutMs);
        ws.on('error', (e) => { clearTimeout(t); reject(e); });
        ws.on('close', () => { clearTimeout(t); reject(new Error('nwc: relay closed')); });
        ws.on('message', (d) => {
          try {
            const m = JSON.parse(d.toString());
            if (m[0] === 'EVENT' && m[1] === sub) {
              const ev = m[2] as Event;
              if (!verifyEvent(ev) || ev.pubkey !== this.conn.walletPubkey) return;
              if (!ev.tags.some((x) => x[0] === 'e' && x[1] === reqEvent.id)) return;
              clearTimeout(t);
              const body = JSON.parse(this.decrypt(ev.content, mode));
              if (body.error) reject(new NwcError(body.error.code ?? 'OTHER', body.error.message ?? 'wallet error'));
              else resolve(body.result ?? {});
            }
          } catch (e) { /* not for us / undecryptable */ }
        });
        // subscribe BEFORE publishing so the response cannot be missed
        ws.send(JSON.stringify(['REQ', sub, { kinds: [23195], authors: [this.conn.walletPubkey], '#e': [reqEvent.id], '#p': [this.pk] }]));
        ws.send(JSON.stringify(['EVENT', reqEvent]));
      });
      return result as T;
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- LnBackend
  async createInvoice(amountSats: bigint, memo: string): Promise<Invoice> {
    const r = await this.request<{ invoice: string; payment_hash?: string }>('make_invoice', {
      amount: Number(amountSats) * 1000, description: memo, expiry: 3600,
    });
    if (!r.invoice) throw new Error('nwc: wallet returned no invoice');
    const d = decodeBolt11(r.invoice);
    if (d.amountSats !== amountSats) throw new Error('nwc: wallet returned an invoice with a different amount');
    return { bolt11: r.invoice, paymentHash: r.payment_hash ?? d.paymentHash, expiry: 3600 };
  }

  private async lookup(paymentHash: string): Promise<any | null> {
    try {
      return await this.request('lookup_invoice', { payment_hash: paymentHash });
    } catch (e) {
      if (e instanceof NwcError && ['NOT_FOUND', 'INTERNAL'].includes(e.code)) return null;
      throw e;
    }
  }
  private settled(p: any) {
    return !!(p && (p.state === 'settled' || p.settled_at || (p.preimage && p.state !== 'failed' && p.state !== 'pending')));
  }

  async isPaid(paymentHash: string): Promise<boolean> {
    return this.settled(await this.lookup(paymentHash));
  }

  private statusOf(p: any): PayResult {
    if (this.settled(p)) {
      return { status: 'PAID', preimage: p.preimage, feeSats: BigInt(Math.ceil(Number(p.fees_paid ?? 0) / 1000)) };
    }
    if (p.state === 'failed' || p.state === 'expired') return { status: 'FAILED' };
    return { status: 'PENDING' };
  }

  async pay(bolt11: string, _maxFeeSats: bigint): Promise<PayResult> {
    const d = decodeBolt11(bolt11);
    const known = await this.lookup(d.paymentHash);
    if (known) return this.statusOf(known); // never pay the same invoice twice
    try {
      const r = await this.request<{ preimage?: string; fees_paid?: number }>('pay_invoice', { invoice: bolt11 });
      return { status: 'PAID', preimage: r.preimage, feeSats: BigInt(Math.ceil(Number(r.fees_paid ?? 0) / 1000)) };
    } catch (e) {
      if (e instanceof NwcError) return { status: 'FAILED' }; // explicit refusal: nothing was sent
      throw e; // timeout/transport: outcome unknown => caller keeps the quote PENDING
    }
  }

  async payStatus(paymentHash: string): Promise<PayResult> {
    const p = await this.lookup(paymentHash);
    return p ? this.statusOf(p) : { status: 'FAILED' };
  }

  decode(bolt11: string) {
    return decodeBolt11(bolt11);
  }

  async balanceSats(): Promise<bigint | null> {
    try {
      const r = await this.request<{ balance: number }>('get_balance', {});
      return typeof r.balance === 'number' ? BigInt(Math.floor(r.balance / 1000)) : null;
    } catch {
      return null;
    }
  }
}

