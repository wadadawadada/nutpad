// Lightning via an UPSTREAM Cashu mint (e.g. https://cashu.mutinynet.com on signet).
//
// nutpad's treasury is a wallet at that mint: deposits are upstream mint quotes (the upstream mint's
// node produces the invoice) and withdrawals are upstream melts. Same idea as the Mesh&Cash wallet,
// no Lightning node, NWC link or LNbits needed.
//
// Safety: the wallet uses DETERMINISTIC secrets (seed derived from MINT_SEED + a DB-backed counter), so
// proofs lost in a crash window can be recovered with NUT-09 restore. Every treasury mutation is
// serialised by a mutex, and an invoice that was already melted is never paid again.
import { Wallet, type Proof } from '@cashu/cashu-ts';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { big, type Db } from './db.js';
import { decodeBolt11, type Invoice, type LnBackend, type LnNetwork, type PayResult } from './ln.js';

class DbCounters {
  constructor(private db: Db) {}
  async reserve(keysetId: string, n: number) {
    const r = await this.db.tx(async (c) => {
      await c.query(`INSERT INTO treasury_counters(keyset_id,next) VALUES($1,0) ON CONFLICT DO NOTHING`, [keysetId]);
      const cur = (await c.query<any>(`SELECT next FROM treasury_counters WHERE keyset_id=$1 FOR UPDATE`, [keysetId])).rows[0];
      const start = Number(cur.next);
      if (n > 0) await c.query(`UPDATE treasury_counters SET next=$2 WHERE keyset_id=$1`, [keysetId, start + n]);
      return start;
    });
    return { start: r, count: n };
  }
  async advanceToAtLeast(keysetId: string, minNext: number) {
    await this.db.query(`INSERT INTO treasury_counters(keyset_id,next) VALUES($1,$2) ON CONFLICT (keyset_id) DO UPDATE SET next=GREATEST(treasury_counters.next,$2)`, [keysetId, minNext]);
  }
  async snapshot() {
    const r = await this.db.query<any>(`SELECT keyset_id,next FROM treasury_counters`);
    return Object.fromEntries(r.rows.map((x) => [x.keyset_id, Number(x.next)]));
  }
}

export class UpstreamCashuBackend implements LnBackend {
  name = 'cashu-upstream';
  private wallet: Wallet | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private seed: Uint8Array;

  constructor(private db: Db, private url: string, mintSeed: Uint8Array, public network: LnNetwork) {
    this.seed = hmac(sha512, mintSeed, utf8ToBytes('nutpad/treasury-wallet/v1'));
  }

  /** run `fn` exclusively: treasury proofs must never be selected twice */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async w(): Promise<Wallet> {
    if (!this.wallet) {
      const w = new Wallet(this.url, { unit: 'sat', bip39seed: this.seed, counterSource: new DbCounters(this.db) as any });
      await w.loadMint();
      this.wallet = w;
    }
    return this.wallet;
  }

  // ------------------------------------------------------------ proof store
  private async unspent(): Promise<Proof[]> {
    const r = await this.db.query<any>(`SELECT proof FROM treasury_proofs WHERE state='UNSPENT'`);
    return r.rows.map((x) => x.proof as Proof);
  }
  private async store(proofs: Proof[], state: 'UNSPENT' | 'PENDING') {
    for (const p of proofs)
      await this.db.query(
        `INSERT INTO treasury_proofs(secret,keyset_id,amount,proof,state) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (secret) DO UPDATE SET state=EXCLUDED.state`,
        [p.secret, p.id, p.amount, JSON.stringify(p), state],
      );
  }
  private async setState(proofs: Proof[], state: 'UNSPENT' | 'PENDING' | 'SPENT') {
    for (const p of proofs) await this.db.query(`UPDATE treasury_proofs SET state=$2 WHERE secret=$1`, [p.secret, state]);
  }
  private async proofsOfMelt(hash: string): Promise<Proof[]> {
    const m = (await this.db.query<any>(`SELECT send_proofs FROM upstream_melts WHERE payment_hash=$1`, [hash])).rows[0];
    return (m?.send_proofs ?? []) as Proof[];
  }

  /** Recover proofs whose signatures the upstream mint issued but that we failed to persist (NUT-09). */
  async recover(): Promise<number> {
    const w = await this.w();
    const known = new Set((await this.db.query<any>(`SELECT secret FROM treasury_proofs`)).rows.map((r) => r.secret as string));
    const keysetId = w.keysetId;
    const { proofs, lastCounterWithSignature } = await w.batchRestore(100, 100, 0, keysetId);
    const fresh = proofs.filter((p) => !known.has(p.secret));
    let added = 0;
    if (fresh.length) {
      const st = await w.checkProofsStates(fresh);
      const live = fresh.filter((_, i) => st[i]?.state === 'UNSPENT');
      await this.store(live, 'UNSPENT');
      added = live.length;
    }
    if (lastCounterWithSignature !== undefined) await new DbCounters(this.db).advanceToAtLeast(keysetId, lastCounterWithSignature + 1);
    return added;
  }

  // ------------------------------------------------------------ LnBackend
  async createInvoice(amountSats: bigint, memo: string): Promise<Invoice> {
    const w = await this.w();
    const q = await w.createMintQuoteBolt11(Number(amountSats), memo);
    const d = decodeBolt11(q.request);
    if (d.network !== this.network) throw new Error(`upstream mint issued a ${d.network} invoice but LN_NETWORK is ${this.network}`);
    if (d.amountSats !== amountSats) throw new Error('upstream mint returned an invoice with a different amount');
    await this.db.query(
      `INSERT INTO upstream_quotes(quote_id,amount,bolt11,payment_hash) VALUES($1,$2,$3,$4)`,
      [q.quote, amountSats.toString(), q.request, d.paymentHash],
    );
    return { bolt11: q.request, paymentHash: d.paymentHash, expiry: Math.max(60, (q.expiry ?? 0) - Math.floor(Date.now() / 1000)) || 3600 };
  }

  async isPaid(paymentHash: string): Promise<boolean> {
    const row = (await this.db.query<any>(`SELECT * FROM upstream_quotes WHERE payment_hash=$1`, [paymentHash])).rows[0];
    if (!row) return false;
    if (row.state === 'CLAIMED') return true;
    return this.locked(async () => {
      const cur = (await this.db.query<any>(`SELECT state FROM upstream_quotes WHERE payment_hash=$1`, [paymentHash])).rows[0];
      if (cur.state === 'CLAIMED') return true;
      const w = await this.w();
      const q = await w.checkMintQuoteBolt11(row.quote_id);
      if (q.state === 'PAID') {
        const proofs = await w.mintProofs(Number(big(row.amount)), row.quote_id);
        await this.store(proofs, 'UNSPENT');
        await this.db.query(`UPDATE upstream_quotes SET state='CLAIMED' WHERE quote_id=$1`, [row.quote_id]);
        return true;
      }
      if (q.state === 'ISSUED') {
        // issued upstream but we did not record it (crash window): restore from the deterministic seed
        await this.recover();
        await this.db.query(`UPDATE upstream_quotes SET state='CLAIMED' WHERE quote_id=$1`, [row.quote_id]);
        return true;
      }
      return false;
    });
  }

  async pay(bolt11: string, _maxFeeSats: bigint): Promise<PayResult> {
    const d = decodeBolt11(bolt11);
    const known = (await this.db.query<any>(`SELECT 1 FROM upstream_melts WHERE payment_hash=$1`, [d.paymentHash])).rows[0];
    if (known) return this.payStatus(d.paymentHash); // never pay the same invoice twice
    return this.locked(async () => {
      const w = await this.w();
      let quote, keep: Proof[], send: Proof[], pool: Proof[];
      try {
        quote = await w.createMeltQuoteBolt11(bolt11);
        const total = quote.amount + quote.fee_reserve;
        pool = await this.unspent();
        if (pool.reduce((a, p) => a + p.amount, 0) < total) return { status: 'FAILED' as const };
        // split off exactly what the melt needs (this may swap at the upstream mint)
        ({ keep, send } = await w.send(total, pool, { includeFees: true }));
      } catch (e) {
        console.error('[treasury] could not prepare melt (nothing was sent):', (e as Error).message);
        return { status: 'FAILED' as const };
      }
      await this.setState(pool, 'SPENT');
      await this.store(keep, 'UNSPENT');
      await this.store(send, 'PENDING');
      await this.db.query(
        `INSERT INTO upstream_melts(payment_hash,quote_id,state,send_proofs,fee_reserve) VALUES($1,$2,'PENDING',$3,$4)`,
        [d.paymentHash, quote.quote, JSON.stringify(send), String(quote.fee_reserve)],
      );
      try {
        const res = await w.meltProofsBolt11(quote, send);
        return await this.settleMelt(d.paymentHash, res.quote, res.change ?? []);
      } catch (e) {
        // unknown outcome: ask the upstream mint what happened to the quote
        try {
          const q = await w.checkMeltQuoteBolt11(quote.quote);
          return await this.settleMelt(d.paymentHash, q, []);
        } catch {
          throw e; // cannot tell => the caller keeps the quote PENDING and the reconciler retries
        }
      }
    });
  }

  private async settleMelt(hash: string, q: { state: string; payment_preimage?: string | null; quote: string }, change: Proof[]): Promise<PayResult> {
    const send = await this.proofsOfMelt(hash);
    const meltRow = (await this.db.query<any>(`SELECT fee_reserve FROM upstream_melts WHERE payment_hash=$1`, [hash])).rows[0];
    if (q.state === 'PAID') {
      await this.setState(send, 'SPENT');
      if (change.length) await this.store(change, 'UNSPENT');
      else await this.recover().catch(() => 0); // change from overpaid fees, if any
      const changeSum = change.reduce((a, p) => a + p.amount, 0);
      const fee = Math.max(0, Number(meltRow.fee_reserve) - changeSum);
      await this.db.query(`UPDATE upstream_melts SET state='PAID', preimage=$2, fee_paid=$3, updated_at=now() WHERE payment_hash=$1`, [hash, q.payment_preimage ?? null, String(fee)]);
      return { status: 'PAID', preimage: q.payment_preimage ?? undefined, feeSats: BigInt(fee) };
    }
    if (q.state === 'UNPAID') {
      await this.setState(send, 'UNSPENT'); // the proofs were never spent upstream
      await this.db.query(`UPDATE upstream_melts SET state='FAILED', updated_at=now() WHERE payment_hash=$1`, [hash]);
      return { status: 'FAILED' };
    }
    return { status: 'PENDING' };
  }

  async payStatus(paymentHash: string): Promise<PayResult> {
    const m = (await this.db.query<any>(`SELECT * FROM upstream_melts WHERE payment_hash=$1`, [paymentHash])).rows[0];
    if (!m) return { status: 'FAILED' };
    if (m.state === 'PAID') return { status: 'PAID', preimage: m.preimage ?? undefined, feeSats: big(m.fee_paid ?? 0) };
    if (m.state === 'FAILED') return { status: 'FAILED' };
    return this.locked(async () => {
      const w = await this.w();
      const q = await w.checkMeltQuoteBolt11(m.quote_id);
      return this.settleMelt(paymentHash, q, []);
    });
  }

  decode(bolt11: string) {
    return decodeBolt11(bolt11);
  }

  async balanceSats(): Promise<bigint | null> {
    const r = await this.db.query<any>(`SELECT COALESCE(SUM(amount),0) AS s FROM treasury_proofs WHERE state IN ('UNSPENT','PENDING')`);
    return big(r.rows[0].s);
  }

  private lastCheck = 0;
  private lastRecover = 0;

  /**
   * Worker hook. The upstream mint rate-limits, so this is deliberately infrequent:
   * a proof-state check every 10 minutes and a full NUT-09 restore every hour.
   */
  async reconcile(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCheck < 10 * 60_000) return;
    this.lastCheck = now;
    await this.locked(async () => {
      const w = await this.w();
      const pool = await this.unspent();
      if (pool.length) {
        const st = await w.checkProofsStates(pool);
        const spent = pool.filter((_, i) => st[i]?.state === 'SPENT');
        if (spent.length) await this.setState(spent, 'SPENT');
      }
      if (now - this.lastRecover >= 60 * 60_000) {
        this.lastRecover = now;
        await this.recover();
      }
    });
  }
}
