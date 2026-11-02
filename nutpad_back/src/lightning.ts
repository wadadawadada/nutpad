// Lightning on/off ramp: NUT-04 style mint (deposit) and NUT-05 style melt (withdraw).
//
// Deposit: quote -> user pays invoice -> mint signs sat outputs (idempotent per quote).
// Withdraw: inputs are marked PENDING *before* any money leaves, then the invoice is paid
// OUTSIDE the DB transaction. The quote row is a small state machine
//   UNPAID -> PENDING -> PAID            (change is signed only after payment succeeded)
//                    \-> UNPAID (refund) (payment failed: pending proofs are released)
// and a reconciler resolves PENDING quotes after crashes/timeouts. Exactly one request (the
// one that moved UNPAID->PENDING) is allowed to call pay(); the invoice is also never paid twice
// because the LN backend refuses to re-pay a known payment hash.
import { randomBytes } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { config } from './config.js';
import { big, type Conn } from './db.js';
import { Mint, sumAmounts, unspentByKeyset, type BlindedMessage, type Proof } from './mint.js';
import { ApiError, canonical, jsonSafe, sha256Hex } from './util.js';
import type { LnBackend, LnNetwork } from './ln.js';

const lnOrThrow = (mint: Mint): LnBackend => {
  if (!mint.ln) throw new ApiError(503, 'LN_DISABLED', 'Lightning is not configured on this mint');
  return mint.ln;
};
const addMeta = (c: Conn, key: string, n: bigint) =>
  c.query(
    `INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=(meta.value::bigint + $2::bigint)::text`,
    [key, n.toString()],
  );
const commitmentOf = (outs: BlindedMessage[]) => sha256Hex(canonical((outs ?? []).map((o) => o.B_)));

/** fee reserve charged on withdrawals: max(2 sats, 1%) */
export const feeReserve = (amount: bigint) => {
  const pct = (amount + 99n) / 100n;
  return pct > 2n ? pct : 2n;
};

// ------------------------------------------------------------------ deposit

export async function mintQuote(mint: Mint, body: { amount: unknown; unit?: string }) {
  const ln = lnOrThrow(mint);
  if (body.unit && body.unit !== 'sat') throw new ApiError(400, 'BAD_UNIT', 'only unit "sat" can be deposited');
  let amount: bigint;
  try { amount = BigInt(body.amount as any); } catch { throw new ApiError(400, 'BAD_AMOUNT', 'amount must be an integer'); }
  if (amount < 1n || amount > config.ln.maxSats) throw new ApiError(400, 'BAD_AMOUNT', `amount must be 1..${config.ln.maxSats} sats`);
  const inv = await ln.createInvoice(amount, 'nutpad deposit');
  const quoteId = bytesToHex(randomBytes(16));
  const expires = new Date(Date.now() + inv.expiry * 1000);
  await mint.db.query(
    `INSERT INTO mint_quotes(quote_id,amount,bolt11,payment_hash,expires_at) VALUES($1,$2,$3,$4,$5)`,
    [quoteId, amount.toString(), inv.bolt11, inv.paymentHash, expires.toISOString()],
  );
  return { quote: quoteId, request: inv.bolt11, amount, unit: 'sat', state: 'UNPAID', expiry: Math.floor(expires.getTime() / 1000), network: ln.network };
}

async function refreshMintQuote(mint: Mint, c: Conn, id: string, lock = false) {
  const q = (await c.query<any>(`SELECT * FROM mint_quotes WHERE quote_id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!q) throw new ApiError(404, 'QUOTE_NOT_FOUND');
  if (q.state === 'UNPAID') {
    if (mint.ln && (await mint.ln.isPaid(q.payment_hash))) {
      await c.query(`UPDATE mint_quotes SET state='PAID' WHERE quote_id=$1 AND state='UNPAID'`, [id]);
      q.state = 'PAID';
    } else if (new Date(q.expires_at).getTime() < Date.now()) q.state = 'EXPIRED';
  }
  return q;
}

export async function mintQuoteState(mint: Mint, id: string) {
  const q = await refreshMintQuote(mint, mint.db, id);
  return { quote: id, request: q.bolt11, amount: big(q.amount), unit: 'sat', state: q.state, expiry: Math.floor(new Date(q.expires_at).getTime() / 1000) };
}

export async function mintTokens(mint: Mint, body: { quote: string; outputs: BlindedMessage[] }) {
  lnOrThrow(mint);
  if (typeof body.quote !== 'string' || !/^[0-9a-f]{32}$/.test(body.quote)) throw new ApiError(400, 'BAD_PARAM', 'quote');
  return mint.db.tx(async (c) => {
    const q = await refreshMintQuote(mint, c, body.quote, true);
    const commit = commitmentOf(body.outputs);
    if (q.state === 'ISSUED') {
      // recovery path: same blinded outputs => the original signatures
      if (q.output_commitment === commit) return q.result;
      throw new ApiError(409, 'ALREADY_ISSUED', 'tokens for this quote were already issued');
    }
    if (q.state !== 'PAID') throw new ApiError(402, 'QUOTE_NOT_PAID', `quote is ${q.state}`);
    const sum = mint.checkOutputs(body.outputs, (k) => k.id === mint.satKeysetId);
    if (sum !== big(q.amount)) throw new ApiError(400, 'UNBALANCED', `outputs must sum to ${big(q.amount)}`);
    const signatures = await mint.signOutputs(c, body.outputs, 'ln-mint:' + body.quote);
    const result = jsonSafe({ signatures });
    await c.query(`UPDATE mint_quotes SET state='ISSUED', output_commitment=$2, result=$3 WHERE quote_id=$1`, [body.quote, commit, JSON.stringify(result)]);
    await addMeta(c, 'ln_in', big(q.amount));
    return result;
  });
}

// ------------------------------------------------------------------ withdraw

export async function meltQuote(mint: Mint, body: { request: string; unit?: string }) {
  const ln = lnOrThrow(mint);
  if (body.unit && body.unit !== 'sat') throw new ApiError(400, 'BAD_UNIT', 'only unit "sat" can be withdrawn');
  if (typeof body.request !== 'string' || body.request.length > 2000) throw new ApiError(400, 'BAD_INVOICE');
  let d;
  try { d = ln.decode(body.request.trim()); } catch (e: any) { throw new ApiError(400, 'BAD_INVOICE', e.message); }
  const expected: LnNetwork = ln.network;
  if (d.network !== expected) throw new ApiError(400, 'WRONG_NETWORK', `this mint is on ${expected}; the invoice is for ${d.network}`);
  if (d.amountSats < 1n || d.amountSats > config.ln.maxSats) throw new ApiError(400, 'BAD_AMOUNT', `amount must be 1..${config.ln.maxSats} sats`);
  if (d.expiresAt * 1000 < Date.now() + 30_000) throw new ApiError(400, 'INVOICE_EXPIRED', 'invoice is expired or about to expire');
  const reserve = feeReserve(d.amountSats);
  const existing = (await mint.db.query<any>(`SELECT * FROM melt_quotes WHERE payment_hash=$1`, [d.paymentHash])).rows[0];
  if (existing) {
    if (existing.state !== 'UNPAID') throw new ApiError(409, 'INVOICE_ALREADY_USED', 'this invoice is already being paid or was paid');
    return meltView(existing);
  }
  const id = bytesToHex(randomBytes(16));
  const expires = new Date(Math.min(d.expiresAt * 1000 - 20_000, Date.now() + 10 * 60_000));
  await mint.db.query(
    `INSERT INTO melt_quotes(quote_id,bolt11,payment_hash,amount,fee_reserve,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
    [id, body.request.trim(), d.paymentHash, d.amountSats.toString(), reserve.toString(), expires.toISOString()],
  );
  return meltView((await mint.db.query<any>(`SELECT * FROM melt_quotes WHERE quote_id=$1`, [id])).rows[0]);
}

const meltView = (q: any) => ({
  quote: q.quote_id, request: q.bolt11, amount: big(q.amount), fee_reserve: big(q.fee_reserve), unit: 'sat',
  state: q.state, expiry: Math.floor(new Date(q.expires_at).getTime() / 1000), payment_preimage: q.preimage ?? null,
});

export async function meltQuoteState(mint: Mint, id: string) {
  const q = (await mint.db.query<any>(`SELECT * FROM melt_quotes WHERE quote_id=$1`, [id])).rows[0];
  if (!q) throw new ApiError(404, 'QUOTE_NOT_FOUND');
  return meltView(q);
}

/** Σ sat obligations of the mint (ecash outstanding + curve reserves + all fees) */
export async function satObligations(mint: Mint, c: Conn): Promise<bigint> {
  const unspent = await unspentByKeyset(c);
  const a = (await c.query<any>(`SELECT reserve_sats,creator_fee_accrued,creator_fee_claimed,buyback_carry FROM assets`)).rows;
  const plat = big((await c.query<any>(`SELECT fees_sats FROM platform_ledger WHERE id=1`)).rows[0].fees_sats);
  return (unspent.get(mint.satKeysetId) ?? 0n) + a.reduce((s, r) => s + big(r.reserve_sats) + big(r.creator_fee_accrued) - big(r.creator_fee_claimed) + big(r.buyback_carry), 0n) + plat;
}

export async function inFlightMelts(c: Conn): Promise<bigint> {
  const r = await c.query<any>(`SELECT COALESCE(SUM(inputs_total),0) AS s FROM melt_quotes WHERE state='PENDING'`);
  return big(r.rows[0].s);
}

export async function meltTokens(mint: Mint, body: { quote: string; inputs: Proof[]; outputs?: BlindedMessage[] }) {
  const ln = lnOrThrow(mint);
  if (typeof body.quote !== 'string' || !/^[0-9a-f]{32}$/.test(body.quote)) throw new ApiError(400, 'BAD_PARAM', 'quote');
  const outputs = body.outputs ?? [];
  const commit = commitmentOf(outputs);

  // ---- phase A (one DB transaction): validate, mark inputs PENDING, claim the right to pay
  const phase = await mint.db.tx(async (c) => {
    const q = (await c.query<any>(`SELECT * FROM melt_quotes WHERE quote_id=$1 FOR UPDATE`, [body.quote])).rows[0];
    if (!q) throw new ApiError(404, 'QUOTE_NOT_FOUND');
    if (q.state === 'PAID') {
      if (q.output_commitment === commit) return { kind: 'done' as const, result: q.result };
      throw new ApiError(409, 'ALREADY_PAID', 'quote already paid');
    }
    if (q.state === 'PENDING') {
      if (q.output_commitment !== commit) throw new ApiError(409, 'QUOTE_PENDING', 'quote is being paid with different outputs');
      return { kind: 'pending' as const, q };
    }
    if (new Date(q.expires_at).getTime() < Date.now()) throw new ApiError(400, 'QUOTE_EXPIRED');
    const amount = big(q.amount), reserve = big(q.fee_reserve);
    const changeSum = mint.checkOutputs(outputs, (k) => k.id === mint.satKeysetId);

    // refuse unsafe treasury transfers (skipped only while the unbacked demo faucet is on)
    if (!config.demoFaucet) {
      const treasury = await ln.balanceSats();
      if (treasury === null) throw new ApiError(503, 'TREASURY_UNKNOWN', 'cannot read treasury balance, withdrawals paused', true);
      const liabilities = (await satObligations(mint, c)) + (await inFlightMelts(c));
      if (treasury < liabilities) throw new ApiError(503, 'TREASURY_UNDERBACKED', 'withdrawals are paused: treasury is below total obligations', true);
      if (treasury < amount + reserve) throw new ApiError(503, 'TREASURY_LOW', 'treasury balance too low for this payment', true);
    }

    const t = await mint.spendInputs(c, body.inputs, 'melt:' + body.quote, 'PENDING');
    if ([...t.keys()].some((k) => k !== mint.satKeysetId)) throw new ApiError(400, 'WRONG_UNIT', 'inputs must be sat proofs');
    const total = t.get(mint.satKeysetId) ?? 0n;
    if (total !== amount + reserve + changeSum) throw new ApiError(400, 'UNBALANCED', `inputs must equal amount ${amount} + fee reserve ${reserve} + change`);
    await c.query(
      `UPDATE melt_quotes SET state='PENDING', inputs_total=$2, change_outputs=$3, output_commitment=$4, updated_at=now() WHERE quote_id=$1`,
      [body.quote, total.toString(), JSON.stringify(outputs), commit],
    );
    return { kind: 'owner' as const, q: { ...q, inputs_total: total.toString(), change_outputs: outputs } };
  });

  if (phase.kind === 'done') return { status: 200, body: phase.result };
  let q = phase.q;

  // ---- phase B (no DB transaction held): move the money. Only the owner calls pay().
  if (phase.kind === 'owner') {
    try {
      const r = await ln.pay(q.bolt11, big(q.fee_reserve));
      return finalize(mint, q, r);
    } catch (e) {
      console.error('[melt] pay() threw, leaving quote PENDING for the reconciler', e);
      return { status: 202, body: { quote: q.quote_id, state: 'PENDING' } };
    }
  }
  // someone else owns the payment: just report its status
  return reconcileMelt(mint, q.quote_id, false);
}

async function finalize(mint: Mint, q: any, r: { status: string; preimage?: string; feeSats?: bigint }): Promise<{ status: number; body: any }> {
  if (r.status === 'PENDING') return { status: 202, body: { quote: q.quote_id, state: 'PENDING' } };
  if (r.status === 'PAID') {
    const body = await mint.db.tx(async (c) => {
      const cur = (await c.query<any>(`SELECT * FROM melt_quotes WHERE quote_id=$1 FOR UPDATE`, [q.quote_id])).rows[0];
      if (cur.state === 'PAID') return cur.result;
      const amount = big(cur.amount), reserve = big(cur.fee_reserve);
      const fee = r.feeSats ?? 0n;
      const outs: BlindedMessage[] = cur.change_outputs ?? [];
      const signatures = await mint.signOutputs(c, outs, 'ln-melt:' + q.quote_id);
      await c.query(`UPDATE proofs SET state='SPENT' WHERE op_ref=$1`, ['melt:' + q.quote_id]);
      const result = jsonSafe({ quote: q.quote_id, state: 'PAID', payment_preimage: r.preimage ?? null, fee_paid: fee, signatures });
      await c.query(
        `UPDATE melt_quotes SET state='PAID', preimage=$2, fee_paid=$3, result=$4, updated_at=now() WHERE quote_id=$1`,
        [q.quote_id, r.preimage ?? null, fee.toString(), JSON.stringify(result)],
      );
      await addMeta(c, 'ln_out_burned', amount + reserve);
      await addMeta(c, 'ln_spent', amount + fee);
      return result;
    });
    return { status: 200, body };
  }
  // FAILED: release the pending proofs, the user keeps full ownership
  await mint.db.tx(async (c) => {
    const cur = (await c.query<any>(`SELECT state FROM melt_quotes WHERE quote_id=$1 FOR UPDATE`, [q.quote_id])).rows[0];
    if (cur.state !== 'PENDING') return;
    await c.query(`DELETE FROM proofs WHERE op_ref=$1 AND state='PENDING'`, ['melt:' + q.quote_id]);
    await c.query(
      `UPDATE melt_quotes SET state='UNPAID', inputs_total=NULL, change_outputs=NULL, output_commitment=NULL, updated_at=now() WHERE quote_id=$1`,
      [q.quote_id],
    );
  });
  throw new ApiError(422, 'PAYMENT_FAILED', 'the Lightning payment failed; your tokens were not spent');
}

/** Resolve a PENDING melt. `force` = from the worker (may refund after the grace period). */
export async function reconcileMelt(mint: Mint, quoteId: string, force: boolean) {
  const ln = lnOrThrow(mint);
  const q = (await mint.db.query<any>(`SELECT * FROM melt_quotes WHERE quote_id=$1`, [quoteId])).rows[0];
  if (!q) throw new ApiError(404, 'QUOTE_NOT_FOUND');
  if (q.state === 'PAID') return { status: 200, body: q.result };
  if (q.state !== 'PENDING') throw new ApiError(409, 'QUOTE_NOT_PENDING');
  const r = await ln.payStatus(q.payment_hash);
  if (r.status === 'FAILED') {
    // FAILED may just mean "pay() has not reached the node yet": only refund after a grace period
    const age = Date.now() - new Date(q.updated_at).getTime();
    if (!(force && age > 60_000)) return { status: 202, body: { quote: quoteId, state: 'PENDING' } };
  }
  return finalize(mint, q, r);
}

export async function reconcileAll(mint: Mint) {
  if (!mint.ln) return;
  const r = (mint.ln as any).reconcile;
  if (typeof r === 'function') await r.call(mint.ln).catch((e: unknown) => console.error('[treasury reconcile]', e));
  const rows = (await mint.db.query<any>(`SELECT quote_id FROM melt_quotes WHERE state='PENDING' AND updated_at < now() - interval '15 seconds'`)).rows;
  for (const r of rows) {
    try { await reconcileMelt(mint, r.quote_id, true); } catch (e) { if (!(e instanceof ApiError)) console.error('[reconcile]', e); }
  }
}

// ------------------------------------------------------------------ solvency view

export async function treasuryReport(mint: Mint) {
  const c = mint.db;
  const meta = async (k: string) => big((await c.query<any>(`SELECT value FROM meta WHERE key=$1`, [k])).rows[0]?.value ?? 0);
  const obligations = await satObligations(mint, c);
  const inflight = await inFlightMelts(c);
  const writtenOff = await meta('ledger_written_off');
  const faucet = await meta('faucet_total'), lnIn = await meta('ln_in'), burned = await meta('ln_out_burned'), spent = await meta('ln_spent');
  const treasury = mint.ln ? await mint.ln.balanceSats().catch(() => null) : null;
  const liabilities = obligations + inflight;
  let status = 'UNVERIFIED';
  if (treasury !== null) status = treasury >= liabilities ? 'BACKED' : 'UNDERBACKED';
  return {
    obligations, in_flight_withdrawals: inflight, liabilities,
    demo_faucet_minted: faucet, ln_deposited: lnIn, ln_withdrawn_ecash: burned, ln_paid_out_incl_fees: spent,
    ledger_conserved: faucet + lnIn === obligations + inflight + burned + writtenOff,
    treasury_assets_sats: treasury, shortfall: treasury !== null && treasury < liabilities ? liabilities - treasury : 0n,
    backing_status: status, ln_backend: mint.ln?.name ?? 'none', ln_network: mint.ln?.network ?? null,
  };
}

