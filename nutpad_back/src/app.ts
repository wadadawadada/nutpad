import { randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { verifyEvent } from 'nostr-tools/pure';
import { config } from './config.js';
import { big } from './db.js';
import { Mint, unspentByKeyset } from './mint.js';
import { ApiError, isHex, jsonSafe, sha256Hex } from './util.js';
import { quoteBuyBudget, quoteBuyUnits, quoteSellUnits, spotPriceNano, SUPPLY, C } from './curve.js';
import * as svc from './services.js';
import * as lnsvc from './lightning.js';
import { consistencyProof, inclusionProof, verifyConsistency, verifyInclusion } from './merkle.js';
import { applyEvent, emptyState, stateRoot, type LogEvent } from './replay.js';
import { dbState, dbStateRoot, leafData } from './audit.js';
import { leafHash } from './merkle.js';

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).then((out) => {
    if (out !== undefined && !res.headersSent) res.json(jsonSafe(out));
  }, next);

const buckets = new Map<string, { n: number; reset: number }>();
const limit = (name: string, max: number, windowMs: number) => (req: Request, _res: Response, next: NextFunction) => {
  const k = `${name}:${req.ip}`;
  const now = Date.now();
  const b = buckets.get(k);
  if (!b || b.reset < now) buckets.set(k, { n: 1, reset: now + windowMs });
  else if (++b.n > max) return next(new ApiError(429, 'RATE_LIMITED', 'too many requests', true));
  next();
};

interface Authed extends Request {
  pubkey?: string;
}

export function createApp(mint: Mint) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    cors({
      origin: config.frontendOrigins.includes('*') ? true : config.frontendOrigins,
      allowedHeaders: ['content-type', 'authorization', 'idempotency-key'],
      exposedHeaders: ['idempotent-replay'],
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  const db = mint.db;

  const requireAuth = async (req: Authed, _res: Response, next: NextFunction) => {
    try {
      const m = /^Bearer ([0-9a-f]{64})$/.exec(req.get('authorization') ?? '');
      if (!m) throw new ApiError(401, 'UNAUTHENTICATED', 'Nostr login required');
      const r = await db.query<any>(`SELECT pubkey FROM sessions WHERE token=$1 AND expires_at>now()`, [m[1]]);
      if (!r.rows[0]) throw new ApiError(401, 'SESSION_EXPIRED', 'session expired, log in again');
      req.pubkey = r.rows[0].pubkey;
      next();
    } catch (e) {
      next(e);
    }
  };
  const idemKey = (req: Request) => req.get('idempotency-key') ?? undefined;
  const respond = (res: Response, out: { result: unknown; replay: boolean }) => {
    if (out.replay) res.setHeader('Idempotent-Replay', 'true');
    return out.result;
  };

  app.get('/health', h(async () => {
    await db.query('SELECT 1');
    return { ok: true };
  }));

  // ------------------------------------------------------------ auth (NIP-98)
  const authUrl = (req: Request) => `${config.apiPublicUrl || `${req.protocol}://${req.get('host')}`}/auth/verify`;

  app.post('/auth/challenge', limit('challenge', 30, 60_000), h(async (req) => {
    const nonce = bytesToHex(randomBytes(16));
    const expires = new Date(Date.now() + 5 * 60_000);
    await db.query(`INSERT INTO auth_challenges(nonce,expires_at) VALUES($1,$2)`, [nonce, expires.toISOString()]);
    await db.query(`DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 hour'`);
    return { challenge: nonce, url: authUrl(req), method: 'POST', expires_at: expires.toISOString(), kind: 27235 };
  }));

  app.post('/auth/verify', limit('verify', 30, 60_000), h(async (req) => {
    const ev = req.body?.event;
    if (!ev || ev.kind !== 27235 || !verifyEvent(ev)) throw new ApiError(401, 'BAD_SIGNATURE', 'invalid auth event');
    const tag = (n: string) => ev.tags.find((t: string[]) => t[0] === n)?.[1];
    if (tag('u') !== authUrl(req) || (tag('method') ?? '').toUpperCase() !== 'POST')
      throw new ApiError(401, 'BAD_AUTH_BINDING', 'event is not bound to this URL/method');
    if (Math.abs(Date.now() / 1000 - ev.created_at) > 120) throw new ApiError(401, 'AUTH_EXPIRED', 'event too old');
    const challenge = tag('challenge');
    const used = await db.query(
      `UPDATE auth_challenges SET used=true WHERE nonce=$1 AND used=false AND expires_at>now() RETURNING nonce`,
      [challenge ?? ''],
    );
    if (!used.rows.length) throw new ApiError(401, 'BAD_CHALLENGE', 'challenge unknown, used or expired');
    const seen = await db.query(`INSERT INTO used_nip98(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id`, [ev.id]);
    if (!seen.rows.length) throw new ApiError(401, 'REPLAY', 'event already used');
    await db.query(`INSERT INTO users(pubkey) VALUES($1) ON CONFLICT DO NOTHING`, [ev.pubkey]);
    const token = bytesToHex(randomBytes(32));
    const expires = new Date(Date.now() + 7 * 86400_000);
    await db.query(`INSERT INTO sessions(token,pubkey,expires_at) VALUES($1,$2,$3)`, [token, ev.pubkey, expires.toISOString()]);
    return { token, pubkey: ev.pubkey, expires_at: expires.toISOString() };
  }));

  app.get('/auth/session', requireAuth, h(async (req: Authed) => ({ pubkey: req.pubkey })));
  app.post('/auth/logout', requireAuth, h(async (req) => {
    await db.query(`DELETE FROM sessions WHERE token=$1`, [(req.get('authorization') ?? '').slice(7)]);
    return { ok: true };
  }));

  // ------------------------------------------------------------ Cashu mint API
  app.get('/v1/info', h(() => ({
    name: 'nutpad mint',
    pubkey: mint.nostrPk,
    version: 'nutpad/0.1',
    description: 'Cashu-native launchpad mint. Custom per-asset units; trade settlement is a nutpad extension.',
    nuts: { '2': { supported: true }, '3': { supported: true }, '4': { supported: !!mint.ln, methods: [{ method: 'bolt11', unit: 'sat' }] }, '5': { supported: !!mint.ln, methods: [{ method: 'bolt11', unit: 'sat' }] }, '7': { supported: true }, '9': { supported: true } },
    demo_faucet: config.demoFaucet,
    demo_mode: config.demoMode,
    ln: { enabled: !!mint.ln, backend: mint.ln?.name ?? 'none', network: mint.ln?.network ?? null, max_sats: config.ln.maxSats.toString() },
    sat_keyset_id: mint.satKeysetId,
  })));
  const listKeysets = () =>
    mint.allKeysets().map((k) => ({ id: k.id, unit: k.unit, active: k.active, input_fee_ppk: 0, asset_id: k.assetId }));
  app.get('/v1/keysets', h(() => ({ keysets: listKeysets() })));
  app.get('/v1/keys', h(() => ({ keysets: mint.allKeysets().map((k) => mint.keysFor(k.id)) })));
  app.get('/v1/keys/:id', h((req) => {
    const k = mint.keysFor(String(req.params.id));
    if (!k) throw new ApiError(404, 'UNKNOWN_KEYSET');
    return { keysets: [k] };
  }));
  app.post('/v1/swap', limit('swap', 120, 60_000), h(async (req, res) => respond(res, await svc.swap(mint, idemKey(req), req.body))));
  app.post('/v1/faucet', limit('faucet', 20, 60_000), h(async (req, res) => respond(res, await svc.faucet(mint, idemKey(req), req.body))));
  // ---- Lightning (NUT-04 / NUT-05 style)
  app.post('/v1/mint/quote/bolt11', limit('mquote', 20, 60_000), h(async (req) => lnsvc.mintQuote(mint, req.body ?? {})));
  app.get('/v1/mint/quote/bolt11/:id', limit('mqstate', 300, 60_000), h(async (req) => lnsvc.mintQuoteState(mint, String(req.params.id))));
  app.post('/v1/mint/bolt11', limit('mmint', 60, 60_000), h(async (req) => lnsvc.mintTokens(mint, req.body ?? {})));
  app.post('/v1/melt/quote/bolt11', limit('lquote2', 20, 60_000), h(async (req) => lnsvc.meltQuote(mint, req.body ?? {})));
  app.get('/v1/melt/quote/bolt11/:id', limit('lqstate', 300, 60_000), h(async (req) => lnsvc.meltQuoteState(mint, String(req.params.id))));
  app.post('/v1/melt/bolt11', limit('lmelt', 30, 60_000), async (req, res, next) => {
    try {
      const r = await lnsvc.meltTokens(mint, req.body ?? {});
      res.status(r.status).json(jsonSafe(r.body));
    } catch (e) { next(e); }
  });

  app.post('/v1/checkstate', h(async (req) => {
    const ys: unknown = req.body?.Ys;
    if (!Array.isArray(ys) || ys.length > 500 || !ys.every((y) => isHex(y, 66))) throw new ApiError(400, 'BAD_PARAM', 'Ys');
    const r = await db.query<any>(`SELECT y,state FROM proofs WHERE y = ANY($1::text[])`, [ys]);
    const st = new Map(r.rows.map((x) => [x.y as string, x.state as string]));
    return { states: ys.map((y: string) => ({ Y: y, state: st.get(y) ?? 'UNSPENT' })) };
  }));
  app.post('/v1/restore', limit('restore', 60, 60_000), h(async (req) => {
    const outs: unknown = req.body?.outputs;
    if (!Array.isArray(outs) || outs.length > 500) throw new ApiError(400, 'BAD_PARAM', 'outputs');
    const bs = outs.map((o: any) => o?.B_).filter((b: unknown) => isHex(b, 66));
    const r = await db.query<any>(
      `SELECT blinded_message,keyset_id,amount,signature FROM outgoing_signatures WHERE blinded_message = ANY($1::text[])`,
      [bs],
    );
    return {
      outputs: r.rows.map((x) => ({ id: x.keyset_id, amount: Number(x.amount), B_: x.blinded_message })),
      signatures: r.rows.map((x) => ({ id: x.keyset_id, amount: Number(x.amount), C_: x.signature })),
    };
  }));

  // ------------------------------------------------------------ assets
  const publicAsset = (r: any) => ({
    asset_id: r.asset_id,
    unit: r.unit,
    name: r.name,
    ticker: r.ticker,
    description: r.description,
    creator_pubkey: r.creator_pubkey,
    image_hash: r.image_hash,
    image_url: `/assets/${r.asset_id}/image`,
    keyset_id: mint.assetKeysetId(r.asset_id) ?? null,
    supply: big(r.supply),
    reserve_sats: big(r.reserve_sats),
    locked_supply: big(r.locked_supply),
    free_supply: big(r.supply) - big(r.locked_supply) - big(r.burned_supply),
    price_nano: spotPriceNano(big(r.supply)),
    trade_count: big(r.trade_count),
    volume_sats: big(r.volume_sats),
    fees_total: big(r.fees_total ?? 0),
    creator_fees: big(r.creator_fee_accrued ?? 0),
    buyback_fees: big(r.fees_total ?? 0) - big(r.creator_fee_accrued ?? 0),
    burned_supply: big(r.burned_supply ?? 0),
    buyback_carry: big(r.buyback_carry ?? 0),
    creator_initial_units: big(r.first_buy_units),
    status: r.status,
    announcement_state: r.announcement_state,
    manifest_hash: r.manifest_hash,
    created_at: r.created_at,
  });
  const ASSET_COLS = `(SELECT COALESCE(SUM(fee_sats),0) FROM trades t WHERE t.asset_id=assets.asset_id) AS fees_total,creator_fee_accrued,asset_id,unit,name,ticker,description,creator_pubkey,image_hash,supply,reserve_sats,locked_supply,burned_supply,buyback_carry,
    trade_count,volume_sats,first_buy_units,status,announcement_state,manifest_hash,created_at`;

  app.get('/assets', h(async (req) => {
    const sort = String(req.query.sort ?? 'new');
    const order = sort === 'volume' ? 'volume_sats DESC' : sort === 'momentum' ? 'trade_count DESC' : 'created_at DESC';
    const r = await db.query(`SELECT ${ASSET_COLS} FROM assets ORDER BY ${order} LIMIT 100`);
    return { assets: r.rows.map(publicAsset) };
  }));

  app.get('/assets/:id', h(async (req) => {
    const r = await db.query<any>(`SELECT ${ASSET_COLS},manifest_json,manifest_event FROM assets WHERE asset_id=$1`, [req.params.id]);
    if (!r.rows[0]) throw new ApiError(404, 'ASSET_NOT_FOUND');
    const alloc = await db.query<any>(`SELECT recipient_pubkey,weight_bps FROM fee_allocations WHERE asset_id=$1 ORDER BY idx`, [req.params.id]);
    return {
      ...publicAsset(r.rows[0]),
      manifest_json: r.rows[0].manifest_json,
      manifest_event: r.rows[0].manifest_event,
      fee_split: alloc.rows.map((a) => ({ pubkey: a.recipient_pubkey, bps: a.weight_bps })),
      mint_pubkey: mint.nostrPk,
    };
  }));

  app.get(['/assets/:id/image', '/assets/:id/image.:ext'], async (req, res, next) => {
    try {
      const r = await db.query<any>(`SELECT image,image_mime,image_hash FROM assets WHERE asset_id=$1`, [req.params.id]);
      if (!r.rows[0]) throw new ApiError(404, 'ASSET_NOT_FOUND');
      res.setHeader('Content-Type', r.rows[0].image_mime);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('ETag', r.rows[0].image_hash);
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.end(Buffer.from(r.rows[0].image));
    } catch (e) {
      next(e);
    }
  });

  app.get('/assets/:id/trades', h(async (req) => {
    const lim = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const r = await db.query<any>(
      `SELECT trade_id,asset_id,seq,side,delta_units,gross_sats,fee_sats,reserve_after,supply_after,receipt_sig,audit_seq,created_at
       FROM trades WHERE asset_id=$1 ORDER BY seq DESC LIMIT $2`,
      [req.params.id, lim],
    );
    return { trades: r.rows.map((t) => ({ ...t, price_nano: spotPriceNano(big(t.supply_after)) })), mint_pubkey: mint.nostrPk };
  }));

  app.get('/assets/:id/buybacks', h(async (req) => {
    const lim = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const r = await db.query<any>(
      `SELECT seq,payload FROM audit_events WHERE event_type='BUYBACK' AND payload::jsonb->>'asset_id'=$1 ORDER BY seq DESC LIMIT $2`,
      [req.params.id, lim],
    );
    return {
      buybacks: r.rows.map((e) => {
        const p = JSON.parse(e.payload);
        return { audit_seq: Number(e.seq), burned_units: p.delta, sats: p.gross, carry_after: p.carry_after, supply_after: p.supply_after, burned_total: p.burned_after, ts: p.ts };
      }),
    };
  }));

  app.get('/assets/:id/vaults', h(async (req) => {
    const r = await db.query<any>(
      `SELECT vault_id,asset_id,amount,unlock_at,state,beneficiary_commitment,lock_audit_seq,lock_receipt_sig,created_at FROM vaults WHERE asset_id=$1 ORDER BY created_at DESC`,
      [req.params.id],
    );
    return { vaults: r.rows.map(vaultView) };
  }));

  const vaultView = (v: any) => ({
    vault_id: v.vault_id,
    asset_id: v.asset_id,
    amount: big(v.amount),
    unlock_at: new Date(v.unlock_at).toISOString(),
    state: v.state === 'LOCKED' && Date.now() >= new Date(v.unlock_at).getTime() ? 'CLAIMABLE' : v.state,
    beneficiary_commitment: v.beneficiary_commitment,
    audit_sequence: big(v.lock_audit_seq),
    receipt_sig: v.lock_receipt_sig,
    locked_at: v.created_at ? new Date(v.created_at).toISOString() : null,
  });

  app.post('/assets/launch/quote', limit('lquote', 60, 60_000), h(async (req) => {
    const d = svc.quoteLaunch(mint, req.body?.manifest);
    let first = null;
    if (req.body?.units) {
      const q = quoteBuyUnits(0n, big(req.body.units));
      first = { delta: q.delta, gross: q.gross, fee: q.fee, total: q.total };
    }
    return { ...d, launch_fee: 1000n, first_buy: first, mint_pubkey: mint.nostrPk };
  }));

  app.post('/assets/launch', requireAuth, limit('launch', 10, 60_000), h(async (req: Authed, res) => {
    const out = await svc.launchAsset(mint, req.pubkey!, req.body);
    return respond(res, out);
  }));

  // ------------------------------------------------------------ trades
  app.post('/trades/quote', limit('tquote', 240, 60_000), h(async (req) => {
    const { asset_id, side, units, sats } = req.body ?? {};
    if (!isHex(asset_id, 64)) throw new ApiError(400, 'BAD_PARAM', 'asset_id');
    const a = (await db.query<any>(`SELECT supply,locked_supply FROM assets WHERE asset_id=$1`, [asset_id])).rows[0];
    if (!a) throw new ApiError(404, 'ASSET_NOT_FOUND');
    const q = big(a.supply);
    try {
      if (String(side).toUpperCase() === 'BUY') {
        if (sats !== undefined) {
          const qt = quoteBuyBudget(q, big(sats));
          if (!qt) throw new ApiError(400, 'BAD_TRADE', 'budget too small');
          return { side: 'BUY', ...qt, supply: q };
        }
        return { side: 'BUY', ...quoteBuyUnits(q, big(units)), supply: q };
      }
      return { side: 'SELL', ...quoteSellUnits(q, big(units)), supply: q };
    } catch (e: any) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(400, 'BAD_TRADE', e.message);
    }
  }));

  app.post('/trades/execute', limit('texec', 120, 60_000), h(async (req, res) =>
    respond(res, await svc.executeTrade(mint, idemKey(req), req.body))));

  app.get('/trades/:id', h(async (req) => {
    const r = await db.query<any>(`SELECT * FROM trades WHERE trade_id=$1`, [req.params.id]);
    if (!r.rows[0]) throw new ApiError(404, 'TRADE_NOT_FOUND');
    return { ...r.rows[0], mint_pubkey: mint.nostrPk };
  }));

  // ------------------------------------------------------------ fees
  app.get('/fees/me', requireAuth, h(async (req: Authed) => {
    const r = await db.query<any>(
      `SELECT b.asset_id,a.ticker,a.unit,b.accrued_sats,b.claimed_sats FROM fee_balances b JOIN assets a USING(asset_id)
       WHERE b.recipient_pubkey=$1 ORDER BY a.created_at DESC`,
      [req.pubkey],
    );
    return { balances: r.rows.map((x) => ({ ...x, claimable_sats: big(x.accrued_sats) - big(x.claimed_sats) })) };
  }));
  app.post('/fees/claim', requireAuth, h(async (req: Authed, res) =>
    respond(res, await svc.claimFees(mint, idemKey(req), req.pubkey!, req.body))));

  // ------------------------------------------------------------ vaults
  app.post('/vaults/lock', requireAuth, h(async (req: Authed, res) =>
    respond(res, await svc.lockVault(mint, idemKey(req), req.pubkey!, req.body))));
  app.get('/vaults', requireAuth, h(async (req: Authed) => {
    const r = await db.query<any>(
      `SELECT v.*,a.ticker,a.unit FROM vaults v JOIN assets a USING(asset_id)
       WHERE v.beneficiary_pubkey=$1 OR v.creator_pubkey=$1 ORDER BY v.created_at DESC`,
      [req.pubkey],
    );
    return {
      vaults: r.rows.map((v) => ({
        ...vaultView(v), ticker: v.ticker, unit: v.unit,
        role: [v.creator_pubkey === req.pubkey ? 'creator' : null, v.beneficiary_pubkey === req.pubkey ? 'beneficiary' : null].filter(Boolean),
        beneficiary_pubkey: v.beneficiary_pubkey, salt: v.salt,
      })),
    };
  }));
  app.get('/vaults/:id', h(async (req) => {
    const r = await db.query<any>(`SELECT * FROM vaults WHERE vault_id=$1`, [req.params.id]);
    if (!r.rows[0]) throw new ApiError(404, 'VAULT_NOT_FOUND');
    return vaultView(r.rows[0]);
  }));
  app.post('/vaults/:id/claim', requireAuth, h(async (req: Authed, res) =>
    respond(res, await svc.claimVault(mint, idemKey(req), req.pubkey!, String(req.params.id), req.body))));

  // ------------------------------------------------------------ audit
  app.get('/audit/events', h(async (req) => {
    const from = Math.max(Number(req.query.from ?? 1) || 1, 1);
    const lim = Math.min(Number(req.query.limit ?? 500) || 500, 1000);
    const r = await db.query<any>(
      `SELECT seq,event_type,payload,leaf_hash,created_at FROM audit_events WHERE seq>=$1 ORDER BY seq LIMIT $2`,
      [from, lim],
    );
    const head = await db.query<any>(`SELECT size FROM audit_head WHERE id=1`);
    return {
      size: big(head.rows[0].size),
      events: r.rows.map((e) => ({ seq: Number(e.seq), type: e.event_type, payload: e.payload, leaf_hash: e.leaf_hash })),
      leaf_format: 'sha256(0x00 || utf8("{seq}|{type}|{payload}"))',
      mint_pubkey: mint.nostrPk,
    };
  }));
  app.get('/audit/checkpoints', h(async (req) => {
    const r = await db.query<any>(`SELECT size,log_root,state_root,totals,signed_event,created_at FROM audit_checkpoints ORDER BY size DESC LIMIT $1`,
      [Math.min(Number(req.query.limit ?? 50) || 50, 500)]);
    return { checkpoints: r.rows.map((c) => ({ ...c, size: Number(c.size) })), mint_pubkey: mint.nostrPk };
  }));
  const allLeaves = async () =>
    (await db.query<any>(`SELECT leaf_hash FROM audit_events ORDER BY seq`)).rows.map((r) => r.leaf_hash as string);
  app.get('/audit/proofs/inclusion', h(async (req) => {
    const seq = Number(req.query.seq);
    const leaves = await allLeaves();
    const size = Math.min(Number(req.query.size ?? leaves.length) || leaves.length, leaves.length);
    if (!Number.isInteger(seq) || seq < 1 || seq > size) throw new ApiError(400, 'BAD_PARAM', 'seq must be within 1..size');
    const part = leaves.slice(0, size);
    return { seq, size, leaf_hash: part[seq - 1], path: inclusionProof(part, seq - 1), root: (await import('./merkle.js')).mth(part) };
  }));
  app.get('/audit/proofs/consistency', h(async (req) => {
    const first = Number(req.query.first), second = Number(req.query.second);
    const leaves = await allLeaves();
    if (!Number.isInteger(first) || !Number.isInteger(second) || first < 1 || first > second || second > leaves.length)
      throw new ApiError(400, 'BAD_PARAM', 'need 1 <= first <= second <= size');
    const { mth } = await import('./merkle.js');
    return { first, second, proof: consistencyProof(leaves, first, second), first_root: mth(leaves.slice(0, first)), second_root: mth(leaves.slice(0, second)) };
  }));

  let statusCache: { at: number; value: unknown } | null = null;
  app.get('/audit/status', h(async () => {
    if (statusCache && Date.now() - statusCache.at < 10_000) return statusCache.value;
    const value = await computeAuditStatus();
    statusCache = { at: Date.now(), value };
    return value;
  }));
  app.get('/audit/assets/:id/status', h(async (req) => {
    const s: any = await computeAuditStatus();
    const a = s.assets[String(req.params.id)];
    return { asset_status: a ?? 'UNKNOWN', global: s.global, checked_size: s.checked_size, latest_checkpoint: s.latest_checkpoint, note: s.note };
  }));

  async function computeAuditStatus() {
    const head = Number(big((await db.query<any>(`SELECT size FROM audit_head WHERE id=1`)).rows[0].size));
    const cp = (await db.query<any>(`SELECT size,state_root,log_root,created_at FROM audit_checkpoints ORDER BY size DESC LIMIT 1`)).rows[0];
    // self-check: replay the whole log and compare with the live database state
    const evs = (await db.query<any>(`SELECT seq,event_type,payload FROM audit_events ORDER BY seq`)).rows;
    const st = emptyState();
    const assets: Record<string, string> = {};
    let global = 'VERIFIED';
    let note = 'Self-check by the operator. Run the independent verifier to confirm.';
    try {
      for (const e of evs) applyEvent(st, { seq: Number(e.seq), type: e.event_type, payload: JSON.parse(e.payload) } as LogEvent);
      const live = dbStateRoot(await dbState(db));
      if (live !== stateRoot(st)) {
        global = 'MISMATCH';
        note = 'database state differs from state replayed from the public log';
      }
    } catch (e: any) {
      global = 'VIOLATION';
      note = e.message;
    }
    if (global === 'VERIFIED' && (!cp || Number(cp.size) < head)) global = cp ? 'STALE' : 'UNKNOWN';
    for (const id of st.assets.keys()) assets[id] = global;
    return { global, assets, checked_size: head, latest_checkpoint: cp ? { size: Number(cp.size), log_root: cp.log_root, state_root: cp.state_root } : null, note, warning_only: true };
  }

  app.get('/audit/solvency', h(async () => {
    const unspent = await unspentByKeyset(db);
    const assets = (await db.query<any>(`SELECT asset_id,ticker,supply,locked_supply,burned_supply,buyback_carry,reserve_sats,creator_fee_accrued,creator_fee_claimed FROM assets`)).rows;
    const sat = unspent.get(mint.satKeysetId) ?? 0n;
    const reserve = assets.reduce((a, r) => a + big(r.reserve_sats), 0n);
    const unclaimed = assets.reduce((a, r) => a + big(r.creator_fee_accrued) - big(r.creator_fee_claimed), 0n);
    const carry = assets.reduce((a, r) => a + big(r.buyback_carry), 0n);
    const platform = big((await db.query<any>(`SELECT fees_sats FROM platform_ledger WHERE id=1`)).rows[0].fees_sats);
    const faucet = big((await db.query<any>(`SELECT value FROM meta WHERE key='faucet_total'`)).rows[0]?.value ?? 0);
    const tokenCheck = assets.map((a) => {
      const ks = mint.assetKeysetId(a.asset_id)!;
      const outstanding = unspent.get(ks) ?? 0n;
      return { asset_id: a.asset_id, ticker: a.ticker, outstanding_token_proofs: outstanding, expected: big(a.supply) - big(a.locked_supply) - big(a.burned_supply), ok: outstanding === big(a.supply) - big(a.locked_supply) - big(a.burned_supply), curve_ok: big(a.reserve_sats) === C(big(a.supply)) };
    });
    const obligations = sat + reserve + unclaimed + platform + carry;
    const t = await lnsvc.treasuryReport(mint);
    return {
      sat_ecash_outstanding: sat,
      curve_reserves: reserve,
      creator_fee_liabilities: unclaimed,
      dev_fund: platform,
      buyback_carry: carry,
      burned_supply: assets.reduce((a, r) => a + big(r.burned_supply), 0n),
      total_sat_obligations: obligations,
      in_flight_withdrawals: t.in_flight_withdrawals,
      demo_faucet_minted: faucet,
      ln_deposited: t.ln_deposited,
      ln_withdrawn_ecash: t.ln_withdrawn_ecash,
      ledger_conserved: t.ledger_conserved,
      token_checks: tokenCheck,
      treasury_assets_sats: t.treasury_assets_sats,
      shortfall: t.shortfall,
      backing_status: t.backing_status,
      ln_backend: t.ln_backend,
      ln_network: t.ln_network,
      note: t.treasury_assets_sats === null
        ? 'No Lightning treasury is connected. A consistent ledger is NOT proof of BTC backing.'
        : 'Treasury balance is read from the operator Lightning wallet and is operator-reported. It is a live check, not a cryptographic proof.',
    };
  }));

  app.get('/nostr/events/:id', h(async (req) => {
    const r = await db.query<any>(`SELECT payload,delivery_state,attempt_count,last_error FROM outbox WHERE event_id=$1`, [req.params.id]);
    if (!r.rows[0]) throw new ApiError(404, 'EVENT_NOT_FOUND');
    return { event: r.rows[0].payload, delivery_state: r.rows[0].delivery_state, attempts: r.rows[0].attempt_count };
  }));

  // ------------------------------------------------------------ errors
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND')));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError)
      return res.status(err.status).json({ error: { code: err.code, message: err.message, retryable: err.retryable } });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'request too large' } });
    if (err instanceof SyntaxError) return res.status(400).json({ error: { code: 'BAD_JSON', message: 'invalid JSON' } });
    if (err?.code === '40001' || err?.code === '40P01')
      return res.status(503).json({ error: { code: 'RETRY', message: 'conflict, retry with the same Idempotency-Key', retryable: true } });
    console.error('[api] unhandled', err?.stack ?? err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error', retryable: false } });
  });

  return app;
}

// re-exported helpers for tests
export { leafData, leafHash, verifyInclusion, verifyConsistency, sha256Hex, utf8ToBytes, SUPPLY };
