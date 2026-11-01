// Financial services: swap, faucet, launch, trade, fees, vaults.
// Every mutating operation runs as ONE database transaction with an idempotency key.
import { randomBytes } from 'node:crypto';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import {
  C,
  distribute,
  feeOf,
  LAUNCH_FEE_SATS,
  MAX_FIRST_BUY_UNITS,
  MIN_FIRST_BUY_SATS,
  quoteBuyUnits,
  quoteSellUnits,
  splitFee,
  SUPPLY,
} from './curve.js';
import { big, type Conn } from './db.js';
import { appendEvent, enqueueNostr } from './audit.js';
import { keysetFor } from './cashu.js';
import { config } from './config.js';
import { Mint, sumAmounts, type BlindedMessage, type BlindSignature, type Proof } from './mint.js';
import { ApiError, canonical, isHex, jsonSafe, sha256Hex } from './util.js';

// ---------------------------------------------------------------- idempotency

export async function idem<T>(
  mint: Mint,
  key: string | undefined,
  op: string,
  req: unknown,
  fn: (c: Conn) => Promise<T>,
): Promise<{ result: T; replay: boolean }> {
  if (!key || key.length < 8 || key.length > 128)
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (8..128 chars) is required');
  const hash = sha256Hex(canonical(req));
  return mint.db.tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO idempotency_keys(key,operation,request_hash,status) VALUES($1,$2,$3,'PENDING')
       ON CONFLICT DO NOTHING RETURNING key`,
      [key, op, hash],
    );
    if (ins.rows.length === 0) {
      const r = (await c.query<any>(`SELECT operation,request_hash,status,result FROM idempotency_keys WHERE key=$1`, [key])).rows[0];
      if (r.operation !== op || r.request_hash !== hash)
        throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'key was used with a different request');
      return { result: r.result as T, replay: true };
    }
    const result = await fn(c);
    await c.query(`UPDATE idempotency_keys SET status='DONE', result=$2 WHERE key=$1`, [key, JSON.stringify(jsonSafe(result))]);
    return { result: jsonSafe(result) as T, replay: false };
  });
}

const opId = () => bytesToHex(randomBytes(16));
const bigParam = (v: unknown, name: string): bigint => {
  try {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) throw 0;
    const b = BigInt(v as any);
    if (b < 0n) throw 0;
    return b;
  } catch {
    throw new ApiError(400, 'BAD_PARAM', `${name} must be a non-negative integer`);
  }
};

// ---------------------------------------------------------------- swap / faucet

export async function swap(mint: Mint, key: string | undefined, body: { inputs: Proof[]; outputs: BlindedMessage[] }) {
  return idem(mint, key, 'swap', body, async (c) => {
    const outSum = mint.checkOutputs(body.outputs, () => true);
    const totals = await mint.spendInputs(c, body.inputs, 'swap');
    // Conservation per unit: every keyset's inputs must equal outputs of the same keyset.
    const outBy = new Map<string, bigint>();
    for (const o of body.outputs) outBy.set(o.id, (outBy.get(o.id) ?? 0n) + BigInt(o.amount));
    const keys = new Set([...totals.keys(), ...outBy.keys()]);
    if (!outSum && totals.size === 0) throw new ApiError(400, 'BAD_INPUTS');
    for (const k of keys)
      if ((totals.get(k) ?? 0n) !== (outBy.get(k) ?? 0n))
        throw new ApiError(400, 'UNBALANCED', 'inputs and outputs must balance per keyset');
    return { signatures: await mint.signOutputs(c, body.outputs, opId()) };
  });
}

export async function faucet(mint: Mint, key: string | undefined, body: { outputs: BlindedMessage[] }) {
  if (!config.demoFaucet) throw new ApiError(403, 'FAUCET_DISABLED', 'demo faucet is disabled');
  return idem(mint, key, 'faucet', body, async (c) => {
    const sum = mint.checkOutputs(body.outputs, (k) => k.id === mint.satKeysetId);
    if (sum <= 0n || sum > 100_000n) throw new ApiError(400, 'BAD_AMOUNT', 'faucet amount must be 1..100000 sats');
    await c.query(
      `INSERT INTO meta(key,value) VALUES('faucet_total',$1)
       ON CONFLICT (key) DO UPDATE SET value=(meta.value::bigint + $1::bigint)::text`,
      [sum.toString()],
    );
    return { signatures: await mint.signOutputs(c, body.outputs, 'faucet:' + opId()) };
  });
}

// ---------------------------------------------------------------- trade core

interface SettleReq {
  assetId: string;
  side: 'BUY' | 'SELL';
  delta: bigint;
  inputs: Proof[];
  outAsset: BlindedMessage[];
  outSat: BlindedMessage[];
  limitSats?: bigint;
  extraSat?: bigint;
  firstBuy?: boolean;
}

export interface TradeResult {
  trade: Record<string, unknown>;
  receipt: { receipt_hash: string; sig: string };
  signatures_asset: BlindSignature[];
  signatures_sat: BlindSignature[];
}

async function settleTrade(mint: Mint, c: Conn, r: SettleReq): Promise<TradeResult> {
  const row = (await c.query<any>(`SELECT * FROM assets WHERE asset_id=$1 FOR UPDATE`, [r.assetId])).rows[0];
  if (!row) throw new ApiError(404, 'ASSET_NOT_FOUND');
  if (row.status !== 'ACTIVE') throw new ApiError(409, 'ASSET_NOT_ACTIVE');
  const assetKs = mint.assetKeysetId(r.assetId);
  if (!assetKs) throw new ApiError(500, 'KEYSET_MISSING');
  const q = big(row.supply);

  mint.checkOutputs(r.outAsset, (k) => k.id === assetKs);
  mint.checkOutputs(r.outSat, (k) => k.id === mint.satKeysetId);
  const outAssetSum = sumAmounts(r.outAsset);
  const outSatSum = sumAmounts(r.outSat);

  let gross: bigint, fee: bigint;
  let operation = opId();
  if (r.side === 'BUY') {
    let qt;
    try {
      qt = quoteBuyUnits(q, r.delta);
    } catch (e: any) {
      throw new ApiError(400, 'BAD_TRADE', e.message);
    }
    gross = qt.gross;
    fee = qt.fee;
    const total = qt.total + (r.extraSat ?? 0n);
    if (r.limitSats !== undefined && qt.total > r.limitSats) throw new ApiError(409, 'SLIPPAGE', 'price moved above your limit');
    if (outAssetSum !== r.delta) throw new ApiError(400, 'UNBALANCED', 'asset outputs must equal delta');
    const t = await mint.spendInputs(c, r.inputs, operation);
    if ([...t.keys()].some((k) => k !== mint.satKeysetId)) throw new ApiError(400, 'WRONG_UNIT', 'BUY inputs must be sat proofs');
    if ((t.get(mint.satKeysetId) ?? 0n) !== total + outSatSum)
      throw new ApiError(400, 'UNBALANCED', `sat inputs must equal ${total} + change`);
  } else {
    let qt;
    try {
      qt = quoteSellUnits(q, r.delta);
    } catch (e: any) {
      throw new ApiError(400, 'BAD_TRADE', e.message);
    }
    gross = qt.gross;
    fee = qt.fee;
    if (r.limitSats !== undefined && qt.payout < r.limitSats) throw new ApiError(409, 'SLIPPAGE', 'price moved below your limit');
    if (outSatSum !== qt.payout) throw new ApiError(400, 'UNBALANCED', `sat outputs must equal payout ${qt.payout}`);
    const t = await mint.spendInputs(c, r.inputs, operation);
    if ([...t.keys()].some((k) => k !== assetKs)) throw new ApiError(400, 'WRONG_UNIT', 'SELL inputs must be asset proofs');
    if ((t.get(assetKs) ?? 0n) !== r.delta + outAssetSum)
      throw new ApiError(400, 'UNBALANCED', 'asset inputs must equal delta + change');
  }

  const supplyAfter = r.side === 'BUY' ? q + r.delta : q - r.delta;
  const reserveAfter = r.side === 'BUY' ? big(row.reserve_sats) + gross : big(row.reserve_sats) - gross;
  if (reserveAfter !== C(supplyAfter)) throw new ApiError(500, 'INVARIANT_VIOLATION', 'reserve != C(supply)');
  if (supplyAfter < big(row.locked_supply)) throw new ApiError(409, 'LOCKED_SUPPLY', 'sell would drop supply below locked supply');

  const { platform, creatorPool } = splitFee(fee);
  const alloc = (await c.query<any>(`SELECT recipient_pubkey,weight_bps FROM fee_allocations WHERE asset_id=$1 ORDER BY idx`, [r.assetId])).rows;
  const parts = distribute(creatorPool, alloc.map((a) => a.weight_bps));
  for (let i = 0; i < alloc.length; i++) {
    if (parts[i] === 0n) continue;
    await c.query(
      `INSERT INTO fee_balances(asset_id,recipient_pubkey,accrued_sats) VALUES($1,$2,$3)
       ON CONFLICT (asset_id,recipient_pubkey) DO UPDATE SET accrued_sats = fee_balances.accrued_sats + $3::bigint`,
      [r.assetId, alloc[i].recipient_pubkey, parts[i].toString()],
    );
  }
  await c.query(`UPDATE platform_ledger SET fees_sats = fees_sats + $1::bigint WHERE id=1`, [platform.toString()]);

  const seq = big(row.trade_count) + 1n;
  const tradeId = bytesToHex(randomBytes(16));
  const creatorSplit = alloc.map((a, i) => ({ pubkey: a.recipient_pubkey, sats: parts[i] }));
  const auditSeq = await appendEvent(c, r.side, {
    trade_id: tradeId,
    asset_id: r.assetId,
    seq,
    delta: r.delta,
    gross,
    fee,
    fee_platform: platform,
    fee_creator: creatorPool,
    creator_split: creatorSplit,
    supply_after: supplyAfter,
    reserve_after: reserveAfter,
  });
  const trade = {
    trade_id: tradeId,
    asset_id: r.assetId,
    seq,
    side: r.side,
    delta_units: r.delta,
    gross_sats: gross,
    fee_sats: fee,
    supply_after: supplyAfter,
    reserve_after: reserveAfter,
    audit_seq: auditSeq,
  };
  const receipt = mint.signReceipt(trade);
  await c.query(
    `INSERT INTO trades(trade_id,asset_id,seq,side,delta_units,gross_sats,fee_sats,reserve_after,supply_after,receipt_sig,audit_seq)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [tradeId, r.assetId, seq.toString(), r.side, r.delta.toString(), gross.toString(), fee.toString(),
      reserveAfter.toString(), supplyAfter.toString(), receipt.sig, auditSeq],
  );
  await c.query(
    `UPDATE assets SET supply=$2, reserve_sats=$3, trade_count=$4, volume_sats=volume_sats+$5::bigint,
       creator_fee_accrued=creator_fee_accrued+$6::bigint WHERE asset_id=$1`,
    [r.assetId, supplyAfter.toString(), reserveAfter.toString(), seq.toString(), gross.toString(), creatorPool.toString()],
  );
  if (r.extraSat) await c.query(`UPDATE platform_ledger SET fees_sats = fees_sats + $1::bigint WHERE id=1`, [r.extraSat.toString()]);

  const signatures_asset = await mint.signOutputs(c, r.outAsset, operation);
  const signatures_sat = await mint.signOutputs(c, r.outSat, operation);
  return { trade, receipt, signatures_asset, signatures_sat };
}

export async function executeTrade(
  mint: Mint,
  key: string | undefined,
  body: {
    asset_id: string;
    side: string;
    delta: string;
    limit_sats?: string;
    inputs: Proof[];
    outputs_asset?: BlindedMessage[];
    outputs_sat?: BlindedMessage[];
  },
) {
  const side = String(body.side).toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new ApiError(400, 'BAD_PARAM', 'side must be BUY or SELL');
  if (!isHex(body.asset_id, 64)) throw new ApiError(400, 'BAD_PARAM', 'asset_id');
  const delta = bigParam(body.delta, 'delta');
  return idem(mint, key, 'trade', body, (c) =>
    settleTrade(mint, c, {
      assetId: body.asset_id,
      side,
      delta,
      inputs: body.inputs,
      outAsset: body.outputs_asset ?? [],
      outSat: body.outputs_sat ?? [],
      limitSats: body.limit_sats !== undefined ? bigParam(body.limit_sats, 'limit_sats') : undefined,
    }),
  );
}

// ---------------------------------------------------------------- launch

const TICKER = /^[A-Z0-9]{2,10}$/;

export interface Manifest {
  v: 1;
  nonce: string;
  issuer: string;
  creator: string;
  name: string;
  ticker: string;
  description: string;
  image_hash: string;
  image_mime: string;
  supply: string;
  curve: { type: 'linear'; start_price_nano: string; reserve_total: string };
  fee_split: { pubkey: string; bps: number }[];
  launch: { fee_sats: string; min_first_buy_sats: string; max_first_buy_units: string };
}

export function validateManifest(mint: Mint, m: any): Manifest {
  const bad = (msg: string) => new ApiError(400, 'BAD_MANIFEST', msg);
  if (!m || typeof m !== 'object' || m.v !== 1) throw bad('v must be 1');
  if (!isHex(m.nonce, 32)) throw bad('nonce must be 32 hex chars');
  if (m.issuer !== mint.nostrPk) throw bad('issuer must equal this mint');
  if (!isHex(m.creator, 64)) throw bad('creator pubkey');
  if (typeof m.name !== 'string' || m.name.trim().length < 1 || m.name.length > 40) throw bad('name 1..40 chars');
  if (typeof m.ticker !== 'string' || !TICKER.test(m.ticker)) throw bad('ticker must be 2..10 chars A-Z0-9');
  if (typeof m.description !== 'string' || m.description.length > 500) throw bad('description <= 500 chars');
  if (!isHex(m.image_hash, 64)) throw bad('image_hash');
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(m.image_mime)) throw bad('image_mime');
  if (m.supply !== SUPPLY.toString()) throw bad('supply must be 21000000');
  if (canonical(m.curve) !== canonical({ type: 'linear', start_price_nano: '1000000', reserve_total: '1000000' }))
    throw bad('curve must be the standard linear curve');
  if (canonical(m.launch) !== canonical({ fee_sats: '1000', min_first_buy_sats: '100', max_first_buy_units: '2100000' }))
    throw bad('launch rules must be the standard rules');
  if (!Array.isArray(m.fee_split) || m.fee_split.length < 1 || m.fee_split.length > 20) throw bad('fee_split 1..20 recipients');
  const seen = new Set<string>();
  let sum = 0;
  for (const f of m.fee_split) {
    if (!f || !isHex(f.pubkey, 64) || !Number.isInteger(f.bps) || f.bps < 1 || f.bps > 10000) throw bad('fee_split entry');
    if (seen.has(f.pubkey)) throw bad('duplicate fee recipient');
    seen.add(f.pubkey);
    sum += f.bps;
  }
  if (sum !== 10000) throw bad('fee_split bps must sum to 10000');
  return m as Manifest;
}

export function deriveAsset(mint: Mint, m: Manifest) {
  const assetId = sha256Hex(canonical(m));
  const unit = `${m.ticker.toLowerCase()}-${assetId.slice(0, 6)}`;
  const ks = keysetFor(mint.seed, assetId, unit);
  return { assetId, unit, keysetId: ks.id, content: canonical(m) };
}

export function sniffImage(b: Uint8Array): string | null {
  const h = (s: string) => bytesToHex(b.slice(0, s.length / 2)) === s;
  if (h('89504e47')) return 'image/png';
  if (h('ffd8ff')) return 'image/jpeg';
  if (h('47494638')) return 'image/gif';
  if (b.length > 12 && h('52494646') && bytesToHex(b.slice(8, 12)) === '57454250') return 'image/webp';
  return null;
}

export function quoteLaunch(mint: Mint, manifest: unknown) {
  const m = validateManifest(mint, manifest);
  const d = deriveAsset(mint, m);
  return { asset_id: d.assetId, unit: d.unit, keyset_id: d.keysetId, content: d.content };
}

export async function launchAsset(
  mint: Mint,
  sessionPubkey: string,
  body: {
    manifest_event: NostrEvent;
    announce_event?: NostrEvent;
    image_b64: string;
    delta: string;
    inputs: Proof[];
    outputs_asset: BlindedMessage[];
    outputs_sat?: BlindedMessage[];
  },
) {
  const ev = body.manifest_event;
  if (!ev || ev.kind !== 30078 || !verifyEvent(ev)) throw new ApiError(400, 'BAD_SIGNATURE', 'manifest event signature invalid');
  if (ev.pubkey !== sessionPubkey) throw new ApiError(403, 'NOT_CREATOR', 'manifest must be signed by the logged-in pubkey');
  let parsed: any;
  try {
    parsed = JSON.parse(ev.content);
  } catch {
    throw new ApiError(400, 'BAD_MANIFEST', 'content is not JSON');
  }
  const m = validateManifest(mint, parsed);
  if (canonical(m) !== ev.content) throw new ApiError(400, 'BAD_MANIFEST', 'manifest content must be canonical JSON');
  if (m.creator !== ev.pubkey) throw new ApiError(400, 'BAD_MANIFEST', 'creator must equal signer');
  const d = deriveAsset(mint, m);
  const note = body.announce_event;
  if (note) {
    if (note.kind !== 1 || note.pubkey !== ev.pubkey || !verifyEvent(note) || typeof note.content !== 'string' || note.content.length > 1000)
      throw new ApiError(400, 'BAD_ANNOUNCEMENT', 'announce_event must be a valid kind 1 note signed by the creator (<=1000 chars)');
  }

  if (typeof body.image_b64 !== 'string' || body.image_b64.length > 400_000) throw new ApiError(400, 'BAD_IMAGE', 'image too large (max ~256KB)');
  const img = Uint8Array.from(Buffer.from(body.image_b64, 'base64'));
  if (img.length === 0 || img.length > 256 * 1024) throw new ApiError(400, 'BAD_IMAGE', 'image size 1..256KB');
  const mime = sniffImage(img);
  if (!mime || mime !== m.image_mime) throw new ApiError(400, 'BAD_IMAGE', 'unsupported or mismatching image type');
  if (sha256Hex(img) !== m.image_hash) throw new ApiError(400, 'BAD_IMAGE', 'image hash mismatch');

  const delta = bigParam(body.delta, 'delta');
  if (delta <= 0n || delta > MAX_FIRST_BUY_UNITS) throw new ApiError(400, 'FIRST_BUY_LIMIT', 'first buy must be 1..2100000 units');
  const first = quoteBuyUnits(0n, delta);
  if (first.total < MIN_FIRST_BUY_SATS) throw new ApiError(400, 'FIRST_BUY_MIN', 'first buy must cost at least 100 sats');

  // launch_id == asset_id: retries return the original result, never a duplicate
  const out = await idem(mint, 'launch:' + d.assetId, 'launch', body, async (c) => {
    const exists = await c.query(`SELECT 1 FROM assets WHERE asset_id=$1`, [d.assetId]);
    if (exists.rows.length) throw new ApiError(409, 'ALREADY_LAUNCHED', 'asset already exists');
    const ksInfo = await mint.registerAssetKeyset(c, d.assetId, d.unit);
    mint.commitKeyset(ksInfo);
    try {
      await c.query(`INSERT INTO users(pubkey) VALUES($1) ON CONFLICT DO NOTHING`, [m.creator]);
      await c.query(
        `INSERT INTO assets(asset_id,creator_pubkey,unit,name,ticker,description,image_hash,image_mime,image,
           manifest_json,manifest_event,manifest_hash,first_buy_units)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [d.assetId, m.creator, d.unit, m.name, m.ticker, m.description, m.image_hash, mime, Buffer.from(img),
          ev.content, JSON.stringify(ev), sha256Hex(ev.content), delta.toString()],
      );
      for (let i = 0; i < m.fee_split.length; i++)
        await c.query(`INSERT INTO fee_allocations(asset_id,idx,recipient_pubkey,weight_bps) VALUES($1,$2,$3,$4)`,
          [d.assetId, i, m.fee_split[i].pubkey, m.fee_split[i].bps]);
      await appendEvent(c, 'LAUNCH', {
        asset_id: d.assetId,
        creator: m.creator,
        unit: d.unit,
        keyset_id: d.keysetId,
        manifest_hash: sha256Hex(ev.content),
        launch_fee: LAUNCH_FEE_SATS,
        fee_split: m.fee_split,
      });
      const res = await settleTrade(mint, c, {
        assetId: d.assetId,
        side: 'BUY',
        delta,
        inputs: body.inputs,
        outAsset: body.outputs_asset,
        outSat: body.outputs_sat ?? [],
        extraSat: LAUNCH_FEE_SATS,
        firstBuy: true,
      });
      await c.query(`INSERT INTO launches(launch_id,asset_id,first_trade_id,launch_fee_sats,status) VALUES($1,$1,$2,$3,'ACTIVE')`,
        [d.assetId, res.trade.trade_id, LAUNCH_FEE_SATS.toString()]);
      await enqueueNostr(c, 'manifest', ev, `asset:${d.assetId}`);
      if (note) await enqueueNostr(c, 'announcement', note, `note:${d.assetId}`);
      return { asset_id: d.assetId, unit: d.unit, keyset_id: d.keysetId, ...res };
    } catch (e) {
      mint.dropKeyset(ksInfo);
      throw e;
    }
  });
  return out;
}

// ---------------------------------------------------------------- creator fees

export async function claimFees(mint: Mint, key: string | undefined, pubkey: string, body: { asset_id: string; outputs: BlindedMessage[] }) {
  if (!isHex(body.asset_id, 64)) throw new ApiError(400, 'BAD_PARAM', 'asset_id');
  return idem(mint, key, 'fee_claim', { ...body, pubkey }, async (c) => {
    await c.query(`SELECT 1 FROM assets WHERE asset_id=$1 FOR UPDATE`, [body.asset_id]);
    const bal = (await c.query<any>(`SELECT accrued_sats,claimed_sats FROM fee_balances WHERE asset_id=$1 AND recipient_pubkey=$2 FOR UPDATE`, [body.asset_id, pubkey])).rows[0];
    const due = bal ? big(bal.accrued_sats) - big(bal.claimed_sats) : 0n;
    if (due <= 0n) throw new ApiError(409, 'NOTHING_TO_CLAIM');
    const sum = mint.checkOutputs(body.outputs, (k) => k.id === mint.satKeysetId);
    if (sum !== due) throw new ApiError(400, 'UNBALANCED', `outputs must sum to ${due}`);
    const claimId = sha256Hex(`fee-claim|${body.asset_id}|${pubkey}|${big(bal.claimed_sats)}`);
    await c.query(`UPDATE fee_balances SET claimed_sats=accrued_sats WHERE asset_id=$1 AND recipient_pubkey=$2`, [body.asset_id, pubkey]);
    await c.query(`UPDATE assets SET creator_fee_claimed=creator_fee_claimed+$2::bigint WHERE asset_id=$1`, [body.asset_id, due.toString()]);
    await c.query(`INSERT INTO claims(claim_id,claim_type,claimant_pubkey,status,output_commitment) VALUES($1,'FEE',$2,'DONE',$3) ON CONFLICT DO NOTHING`,
      [claimId, pubkey, sha256Hex(canonical(body.outputs.map((o) => o.B_)))]);
    await appendEvent(c, 'FEE_CLAIM', { asset_id: body.asset_id, recipient: pubkey, amount: due, claim_id: claimId });
    return { claim_id: claimId, amount: due, signatures: await mint.signOutputs(c, body.outputs, 'fee:' + claimId) };
  });
}

// ---------------------------------------------------------------- vaults

const VAULT_DOMAIN = utf8ToBytes('nutpad/vault/v1');
export const vaultCommitment = (assetId: string, vaultId: string, pubkey: string, salt: string) =>
  bytesToHex(sha256(concatBytes(VAULT_DOMAIN, hexToBytes(assetId), hexToBytes(vaultId), hexToBytes(pubkey), hexToBytes(salt))));

export async function lockVault(
  mint: Mint,
  key: string | undefined,
  creator: string,
  body: {
    asset_id: string;
    beneficiary_pubkey: string;
    duration: string; // '7d' | '30d' | '90d' | 'demo'
    amount: string;
    inputs: Proof[];
    outputs_asset?: BlindedMessage[];
  },
) {
  if (!isHex(body.asset_id, 64) || !isHex(body.beneficiary_pubkey, 64)) throw new ApiError(400, 'BAD_PARAM', 'pubkeys must be hex');
  const days: Record<string, number> = { '7d': 7 * 86400, '30d': 30 * 86400, '90d': 90 * 86400 };
  if (config.demoMode) days['demo'] = config.demoVaultSeconds;
  const secs = days[body.duration];
  if (!secs) throw new ApiError(400, 'BAD_PARAM', 'duration must be 7d, 30d or 90d');
  const amount = bigParam(body.amount, 'amount');
  if (amount <= 0n) throw new ApiError(400, 'BAD_PARAM', 'amount');
  return idem(mint, key, 'vault_lock', { ...body, creator }, async (c) => {
    const a = (await c.query<any>(`SELECT * FROM assets WHERE asset_id=$1 FOR UPDATE`, [body.asset_id])).rows[0];
    if (!a) throw new ApiError(404, 'ASSET_NOT_FOUND');
    if (a.creator_pubkey !== creator) throw new ApiError(403, 'NOT_CREATOR', 'only the creator can lock');
    const ksId = mint.assetKeysetId(body.asset_id)!;
    const outSum = mint.checkOutputs(body.outputs_asset ?? [], (k) => k.id === ksId);
    const t = await mint.spendInputs(c, body.inputs, 'lock');
    if ([...t.keys()].some((k) => k !== ksId)) throw new ApiError(400, 'WRONG_UNIT');
    if ((t.get(ksId) ?? 0n) !== amount + outSum) throw new ApiError(400, 'UNBALANCED', 'inputs must equal amount + change');
    const newLocked = big(a.locked_supply) + amount;
    if (newLocked > big(a.supply)) throw new ApiError(409, 'LOCK_EXCEEDS_SUPPLY');
    const vaultId = bytesToHex(randomBytes(16));
    const salt = bytesToHex(randomBytes(32));
    const commitment = vaultCommitment(body.asset_id, vaultId, body.beneficiary_pubkey, salt);
    const unlockAt = new Date(Date.now() + secs * 1000);
    await c.query(`UPDATE assets SET locked_supply=$2 WHERE asset_id=$1`, [body.asset_id, newLocked.toString()]);
    const auditSeq = await appendEvent(c, 'LOCK', {
      asset_id: body.asset_id, vault_id: vaultId, amount, unlock_at: unlockAt.toISOString(), commitment,
    });
    const receiptBody = { asset_id: body.asset_id, vault_id: vaultId, amount, unlock_at: unlockAt.toISOString(), beneficiary_commitment: commitment, audit_sequence: auditSeq };
    const receipt = mint.signReceipt(receiptBody);
    await c.query(
      `INSERT INTO vaults(vault_id,asset_id,creator_pubkey,beneficiary_commitment,beneficiary_pubkey,salt,amount,unlock_at,lock_audit_seq,lock_receipt_sig)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [vaultId, body.asset_id, creator, commitment, body.beneficiary_pubkey, salt, amount.toString(), unlockAt.toISOString(), auditSeq, receipt.sig],
    );
    return { receipt: { ...receiptBody, sig: receipt.sig }, signatures: await mint.signOutputs(c, body.outputs_asset ?? [], 'lock:' + vaultId) };
  });
}

export async function claimVault(mint: Mint, key: string | undefined, pubkey: string, vaultId: string, body: { outputs: BlindedMessage[] }) {
  if (!isHex(vaultId, 32)) throw new ApiError(400, 'BAD_PARAM', 'vault_id');
  return idem(mint, key, 'vault_claim', { ...body, pubkey, vaultId }, async (c) => {
    const v0 = (await c.query<any>(`SELECT asset_id FROM vaults WHERE vault_id=$1`, [vaultId])).rows[0];
    if (!v0) throw new ApiError(404, 'VAULT_NOT_FOUND');
    await c.query(`SELECT 1 FROM assets WHERE asset_id=$1 FOR UPDATE`, [v0.asset_id]);
    const v = (await c.query<any>(`SELECT * FROM vaults WHERE vault_id=$1 FOR UPDATE`, [vaultId])).rows[0];
    if (v.beneficiary_pubkey !== pubkey) throw new ApiError(403, 'NOT_BENEFICIARY');
    const claimId = sha256Hex('vault-claim|' + vaultId);
    const commitment = sha256Hex(canonical(body.outputs.map((o) => o.B_)));
    if (v.state === 'CLAIMED') {
      // Recovery path: same claim + same blinded outputs => original signatures.
      const cl = (await c.query<any>(`SELECT output_commitment,result_ref FROM claims WHERE claim_id=$1`, [claimId])).rows[0];
      if (cl && cl.output_commitment === commitment) return cl.result_ref;
      throw new ApiError(409, 'ALREADY_CLAIMED', 'vault already redeemed');
    }
    if (Date.now() < new Date(v.unlock_at).getTime()) throw new ApiError(403, 'STILL_LOCKED', 'unlock_at not reached');
    const ksId = mint.assetKeysetId(v.asset_id)!;
    const sum = mint.checkOutputs(body.outputs, (k) => k.id === ksId);
    if (sum !== big(v.amount)) throw new ApiError(400, 'UNBALANCED', `outputs must sum to ${big(v.amount)}`);
    await c.query(`UPDATE assets SET locked_supply=locked_supply-$2::bigint WHERE asset_id=$1`, [v.asset_id, big(v.amount).toString()]);
    await c.query(`UPDATE vaults SET state='CLAIMED', claim_id=$2 WHERE vault_id=$1`, [vaultId, claimId]);
    const auditSeq = await appendEvent(c, 'UNLOCK', { asset_id: v.asset_id, vault_id: vaultId, amount: big(v.amount), claim_id: claimId });
    const signatures = await mint.signOutputs(c, body.outputs, 'unlock:' + claimId);
    const result = { claim_id: claimId, amount: big(v.amount).toString(), audit_sequence: auditSeq, signatures };
    await c.query(`INSERT INTO claims(claim_id,claim_type,claimant_pubkey,status,output_commitment,result_ref) VALUES($1,'VAULT',$2,'DONE',$3,$4)`,
      [claimId, pubkey, commitment, JSON.stringify(result)]);
    return result;
  });
}
