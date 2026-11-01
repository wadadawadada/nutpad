// Lightning backends. The mint only ever talks to this interface.
//  - lnbits: real node via the LNbits REST API (point it at a TESTNET/SIGNET-funded LNbits wallet)
//  - fake:   in-process simulator for local development and tests (no real network)
import { randomBytes } from 'node:crypto';
import { decode } from 'light-bolt11-decoder';
import { config } from './config.js';
import { sha256Hex } from './util.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { NwcBackend, parseNwcUrl } from './nwc.js';
import { UpstreamCashuBackend } from './upstream.js';

export type LnNetwork = 'regtest' | 'signet' | 'testnet' | 'mainnet' | 'fake';

export interface Invoice {
  bolt11: string;
  paymentHash: string;
  expiry: number; // seconds
}
export interface DecodedInvoice {
  amountSats: bigint;
  paymentHash: string;
  expiresAt: number; // unix seconds
  network: LnNetwork;
}
export type PayStatus = 'PAID' | 'PENDING' | 'FAILED';
export interface PayResult {
  status: PayStatus;
  preimage?: string;
  feeSats?: bigint;
}

export interface LnBackend {
  name: string;
  network: LnNetwork;
  createInvoice(amountSats: bigint, memo: string): Promise<Invoice>;
  isPaid(paymentHash: string): Promise<boolean>;
  /** Pay; must be safe to call again for the same invoice (returns the existing status). */
  pay(bolt11: string, maxFeeSats: bigint): Promise<PayResult>;
  payStatus(paymentHash: string): Promise<PayResult>;
  decode(bolt11: string): DecodedInvoice;
  /** Spendable balance of the treasury wallet in sats, or null if unknown. */
  balanceSats(): Promise<bigint | null>;
}

const PREFIX: [string, LnNetwork][] = [['lnbcrt', 'regtest'], ['lntbs', 'signet'], ['lntb', 'testnet'], ['lnbc', 'mainnet']];
export function networkOfInvoice(bolt11: string): LnNetwork {
  const s = bolt11.toLowerCase();
  if (s.startsWith('lnfake')) return 'fake';
  return PREFIX.find(([p]) => s.startsWith(p))?.[1] ?? 'mainnet';
}

export function decodeBolt11(bolt11: string): DecodedInvoice {
  let d;
  try {
    d = decode(bolt11);
  } catch {
    throw new Error('invalid bolt11 invoice');
  }
  const sec = (n: string) => d.sections.find((s: any) => s.name === n) as any;
  const msat = sec('amount')?.value;
  if (!msat) throw new Error('amountless invoices are not supported');
  const hash = sec('payment_hash')?.value as string;
  const ts = Number(sec('timestamp')?.value ?? 0);
  const exp = Number(sec('expiry')?.value ?? 3600);
  return { amountSats: BigInt(msat) / 1000n, paymentHash: hash, expiresAt: ts + exp, network: networkOfInvoice(bolt11) };
}

// ------------------------------------------------------------------ LNbits

export class LnbitsBackend implements LnBackend {
  name = 'lnbits';
  constructor(private url: string, private adminKey: string, public network: LnNetwork) {}

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(this.url + path, {
      method,
      headers: { 'X-Api-Key': this.adminKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, json, text };
  }

  async createInvoice(amountSats: bigint, memo: string): Promise<Invoice> {
    const r = await this.call('POST', '/api/v1/payments', { out: false, amount: Number(amountSats), memo, expiry: 3600 });
    if (!r.ok || !r.json?.payment_request) throw new Error(`lnbits: cannot create invoice (${r.status})`);
    return { bolt11: r.json.payment_request, paymentHash: r.json.payment_hash, expiry: 3600 };
  }

  async isPaid(paymentHash: string): Promise<boolean> {
    const r = await this.call('GET', `/api/v1/payments/${paymentHash}`);
    return r.ok && r.json?.paid === true;
  }

  private async lookup(paymentHash: string): Promise<any | null> {
    const r = await this.call('GET', `/api/v1/payments/${paymentHash}`);
    return r.ok && r.json && typeof r.json.paid === 'boolean' ? r.json : null;
  }

  private statusOf(p: any): PayResult {
    if (p.paid === true) {
      const fee = p.details?.fee ?? p.fee ?? 0;
      return { status: 'PAID', preimage: p.preimage, feeSats: BigInt(Math.ceil(Math.abs(Number(fee)) / 1000)) };
    }
    if (p.details?.status === 'failed' || p.status === 'failed') return { status: 'FAILED' };
    return { status: 'PENDING' };
  }

  async pay(bolt11: string, maxFeeSats: bigint): Promise<PayResult> {
    const d = this.decode(bolt11);
    const known = await this.lookup(d.paymentHash);
    if (known) return this.statusOf(known); // never pay the same invoice twice
    const r = await this.call('POST', '/api/v1/payments', { out: true, bolt11, fee_limit_msat: Number(maxFeeSats) * 1000 });
    if (!r.ok) return { status: 'FAILED' }; // hard refusal (no route, no balance): nothing was sent
    const after = await this.lookup(d.paymentHash);
    return after ? this.statusOf(after) : { status: 'PENDING' };
  }

  async payStatus(paymentHash: string): Promise<PayResult> {
    const p = await this.lookup(paymentHash);
    return p ? this.statusOf(p) : { status: 'FAILED' };
  }

  decode(bolt11: string) {
    return decodeBolt11(bolt11);
  }

  async balanceSats(): Promise<bigint | null> {
    const r = await this.call('GET', '/api/v1/wallet');
    if (!r.ok || typeof r.json?.balance !== 'number') return null;
    return BigInt(Math.floor(r.json.balance / 1000));
  }
}

// ------------------------------------------------------------------ fake (dev/tests)

/** Invoice format: lnfake1_<amount>_<hash>. Created invoices are paid after `payDelayMs`; any fake invoice can be paid out. */
export class FakeLnBackend implements LnBackend {
  name = 'fake';
  network: LnNetwork = 'fake';
  private created = new Map<string, { amount: bigint; paidAt: number }>();
  private outgoing = new Map<string, PayResult>();
  private balance = 0n;
  failNext = false;
  holdNext = false;
  constructor(private payDelayMs = 2500) {}

  async createInvoice(amountSats: bigint): Promise<Invoice> {
    const hash = bytesToHex(randomBytes(32));
    this.created.set(hash, { amount: amountSats, paidAt: Date.now() + this.payDelayMs });
    return { bolt11: `lnfake1_${amountSats}_${hash}`, paymentHash: hash, expiry: 3600 };
  }
  async isPaid(hash: string) {
    const c = this.created.get(hash);
    if (!c || Date.now() < c.paidAt) return false;
    if (!(c as any).counted) { (c as any).counted = true; this.balance += c.amount; }
    return true;
  }
  /** a foreign fake invoice (someone else's node) for withdraw tests */
  static externalInvoice(amountSats: bigint) {
    return `lnfake1_${amountSats}_${bytesToHex(randomBytes(32))}`;
  }
  async pay(bolt11: string, maxFeeSats: bigint): Promise<PayResult> {
    const d = this.decode(bolt11);
    const prev = this.outgoing.get(d.paymentHash);
    if (prev) return prev;
    if (this.failNext) { this.failNext = false; return { status: 'FAILED' }; }
    if (this.holdNext) { this.holdNext = false; const r: PayResult = { status: 'PENDING' }; this.outgoing.set(d.paymentHash, r); return r; }
    const fee = maxFeeSats > 1n ? 1n : 0n;
    if (this.balance < d.amountSats + fee) return { status: 'FAILED' };
    this.balance -= d.amountSats + fee;
    const r: PayResult = { status: 'PAID', preimage: sha256Hex(d.paymentHash), feeSats: fee };
    this.outgoing.set(d.paymentHash, r);
    return r;
  }
  async payStatus(hash: string) { return this.outgoing.get(hash) ?? { status: 'FAILED' as PayStatus }; }
  /** test helper: resolve a held payment */
  settleHeld(hash: string, ok: boolean) {
    this.outgoing.set(hash, ok ? { status: 'PAID', preimage: sha256Hex(hash), feeSats: 1n } : { status: 'FAILED' });
  }
  decode(bolt11: string): DecodedInvoice {
    const m = /^lnfake1_(\d+)_([0-9a-f]{64})$/.exec(bolt11);
    if (!m) throw new Error('invalid bolt11 invoice');
    return { amountSats: BigInt(m[1]), paymentHash: m[2], expiresAt: Math.floor(Date.now() / 1000) + 3600, network: 'fake' };
  }
  async balanceSats() { for (const h of this.created.keys()) await this.isPaid(h); return this.balance; }
}

export function createLnBackend(db?: import('./db.js').Db, mintSeed?: Uint8Array): LnBackend | null {
  const kind = config.ln.backend;
  if (kind === 'none') return null;
  if (kind === 'fake') return new FakeLnBackend();
  if (kind === 'lnbits') {
    if (!config.ln.lnbitsUrl || !config.ln.lnbitsKey) throw new Error('LN_BACKEND=lnbits needs LNBITS_URL and LNBITS_ADMIN_KEY');
    if (config.ln.network === 'mainnet' && !config.ln.allowMainnet)
      throw new Error('Refusing to start on mainnet. This build is testnet-only (set ALLOW_MAINNET=true at your own risk).');
    return new LnbitsBackend(config.ln.lnbitsUrl, config.ln.lnbitsKey, config.ln.network);
  }
  if (kind === 'nwc') {
    if (!config.ln.nwcUrl) throw new Error('LN_BACKEND=nwc needs NWC_URL (nostr+walletconnect://…)');
    if (config.ln.network === 'mainnet' && !config.ln.allowMainnet)
      throw new Error('Refusing to start on mainnet. This build is testnet-only (set ALLOW_MAINNET=true at your own risk).');
    return new NwcBackend(parseNwcUrl(config.ln.nwcUrl), config.ln.network);
  }
  if (kind === 'cashu') {
    if (!db || !mintSeed) throw new Error('internal: cashu backend needs db and seed');
    if (!config.ln.upstreamUrl) throw new Error('LN_BACKEND=cashu needs CASHU_UPSTREAM_URL (e.g. https://cashu.mutinynet.com)');
    if (config.ln.network === 'mainnet' && !config.ln.allowMainnet)
      throw new Error('Refusing to start on mainnet. This build is testnet-only (set ALLOW_MAINNET=true at your own risk).');
    return new UpstreamCashuBackend(db, config.ln.upstreamUrl, mintSeed, config.ln.network);
  }
  throw new Error(`unknown LN_BACKEND ${kind}`);
}
