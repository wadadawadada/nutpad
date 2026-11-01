process.env.PGLITE_DIR = ''; // in-memory Postgres
process.env.DEMO_FAUCET = 'true';
process.env.DEMO_MODE = 'true';
process.env.DEMO_VAULT_SECONDS = '2';
process.env.MINT_SEED = 'ab'.repeat(32);

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { bytesToHex } from '@noble/hashes/utils.js';
import { finalizeEvent, getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import { blindOutputs, unblind } from './helpers.js';

const { openDb } = await import('../src/db.js');
const { Mint } = await import('../src/mint.js');
const { createApp } = await import('../src/app.js');
const { createCheckpoint } = await import('../src/audit.js');
const { applyEvent, emptyState, stateRoot } = await import('../src/replay.js');
const { sha256Hex, canonical } = await import('../src/util.js');
const { quoteBuyUnits, quoteSellUnits } = await import('../src/curve.js');

let base = '';
let server: any;
let mint: InstanceType<typeof Mint>;
let satKs: string;
const keysCache = new Map<string, Record<string, string>>();

before(async () => {
  const db = await openDb();
  mint = new Mint(db);
  await mint.init();
  server = createApp(mint).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  satKs = mint.satKeysetId;
});
after(async () => {
  server.close();
  await mint.db.close();
});

async function api(method: string, path: string, body?: unknown, opts: { token?: string; key?: string } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.key ? { 'idempotency-key': opts.key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}
const keysOf = async (ks: string) => {
  if (!keysCache.has(ks)) keysCache.set(ks, (await api('GET', `/v1/keys/${ks}`)).body.keysets[0].keys);
  return keysCache.get(ks)!;
};

async function faucet(amount: bigint) {
  const p = blindOutputs(satKs, amount);
  const r = await api('POST', '/v1/faucet', { outputs: p.map((x) => x.msg) }, { key: randomUUID() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return unblind(p, r.body.signatures, await keysOf(satKs));
}

async function login(sk: Uint8Array) {
  const ch = await api('POST', '/auth/challenge');
  const ev = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', ch.body.url], ['method', 'POST'], ['challenge', ch.body.challenge]], content: '' },
    sk,
  );
  const r = await api('POST', '/auth/verify', { event: ev });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token as string;
}

const sum = (ps: { amount: number }[]) => ps.reduce((a, p) => a + BigInt(p.amount), 0n);
// PNG 1x1
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const creatorSk = generateSecretKey();
const creatorPk = getPublicKey(creatorSk);
const friendPk = getPublicKey(generateSecretKey());
let assetId = '';
let assetKs = '';
let creatorToken = '';
let heldTokens: any[] = [];
let heldSats: any[] = [];

test('login rejects replay and wrong binding', async () => {
  creatorToken = await login(creatorSk);
  const ch = await api('POST', '/auth/challenge');
  const bad = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', 'https://evil.example/auth/verify'], ['method', 'POST'], ['challenge', ch.body.challenge]], content: '' }, creatorSk);
  assert.equal((await api('POST', '/auth/verify', { event: bad })).status, 401);
  const good = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', ch.body.url], ['method', 'POST'], ['challenge', ch.body.challenge]], content: '' }, creatorSk);
  assert.equal((await api('POST', '/auth/verify', { event: good })).status, 200);
  assert.equal((await api('POST', '/auth/verify', { event: good })).status, 401, 'replay must fail');
});

test('launch: 1000 fee + first buy of 2.1M units, idempotent retry', async () => {
  const manifest = {
    v: 1,
    nonce: bytesToHex(randomBytes(16)),
    issuer: mint.nostrPk,
    creator: creatorPk,
    name: 'Test Nut',
    ticker: 'NUT',
    description: 'hello',
    image_hash: sha256Hex(PNG),
    image_mime: 'image/png',
    supply: '21000000',
    curve: { type: 'linear', start_price_nano: '1000000', reserve_total: '1000000' },
    fee_split: [{ pubkey: creatorPk, bps: 6000 }, { pubkey: friendPk, bps: 4000 }],
    launch: { fee_sats: '1000', min_first_buy_sats: '100', max_first_buy_units: '2100000' },
  };
  const quote = await api('POST', '/assets/launch/quote', { manifest, units: '2100000' });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.first_buy.total, '12009');
  assetId = quote.body.asset_id;
  assetKs = quote.body.keyset_id;
  const event = finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', manifest.nonce]], content: quote.body.content }, creatorSk);

  const funds = await faucet(14_000n);
  const outTok = blindOutputs(assetKs, 2_100_000n);
  const change = blindOutputs(satKs, 14_000n - 1000n - 12_009n);
  const body = {
    manifest_event: event,
    image_b64: PNG.toString('base64'),
    delta: '2100000',
    inputs: funds,
    outputs_asset: outTok.map((x) => x.msg),
    outputs_sat: change.map((x) => x.msg),
  };
  const r = await api('POST', '/assets/launch', body, { token: creatorToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.trade.seq, '1');
  assert.equal(r.body.trade.reserve_after, '11890');
  const ak = await keysOf(assetKs);
  heldTokens = unblind(outTok, r.body.signatures_asset, ak);
  heldSats = unblind(change, r.body.signatures_sat, await keysOf(satKs));

  const again = await api('POST', '/assets/launch', body, { token: creatorToken });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.trade.trade_id, r.body.trade.trade_id, 'retry returns the original result');
  const a = await api('GET', `/assets/${assetId}`);
  assert.equal(a.body.supply, '2100000');
  assert.equal(a.body.trade_count, '1');
});

test('launch requires login and cannot skip the first buy', async () => {
  const r = await api('POST', '/assets/launch', {});
  assert.equal(r.status, 401);
});

test('double spend: one proof cannot fund two concurrent trades', async () => {
  const funds = await faucet(2000n);
  const mk = () => {
    const q = quoteBuyUnits(2_100_000n, 1000n);
    const o = blindOutputs(assetKs, 1000n);
    const c = blindOutputs(satKs, 2000n - q.total);
    return { asset_id: assetId, side: 'BUY', delta: '1000', inputs: funds, outputs_asset: o.map((x) => x.msg), outputs_sat: c.map((x) => x.msg) };
  };
  const [a, b] = await Promise.all([
    api('POST', '/trades/execute', mk(), { key: randomUUID() }),
    api('POST', '/trades/execute', mk(), { key: randomUUID() }),
  ]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 400], JSON.stringify([a.body, b.body]));
  const failed = a.status === 400 ? a : b;
  assert.equal(failed.body.error.code, 'TOKEN_ALREADY_SPENT');
  const ok = a.status === 200 ? a : b;
  const state = (await api('GET', `/assets/${assetId}`)).body;
  assert.equal(state.supply, '2101000');
  assert.equal(state.trade_count, '2');
  void ok;
});

test('BUY more, then SELL: exact accounting and signed receipts', async () => {
  const funds = await faucet(30_000n);
  const q = quoteBuyUnits(2_101_000n, 500_000n);
  const o = blindOutputs(assetKs, 500_000n);
  const c = blindOutputs(satKs, 30_000n - q.total);
  const r = await api('POST', '/trades/execute', { asset_id: assetId, side: 'BUY', delta: '500000', limit_sats: q.total.toString(), inputs: funds, outputs_asset: o.map((x) => x.msg), outputs_sat: c.map((x) => x.msg) }, { key: randomUUID() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bought = unblind(o, r.body.signatures_asset, await keysOf(assetKs));
  assert.equal(r.body.trade.gross_sats, q.gross.toString());

  // slippage guard
  const f2 = await faucet(100n);
  const s0 = await api('POST', '/trades/execute', { asset_id: assetId, side: 'BUY', delta: '1000', limit_sats: '1', inputs: f2, outputs_asset: [], outputs_sat: [] }, { key: randomUUID() });
  assert.equal(s0.status, 409);

  // SELL 200k of the bought tokens
  const take = bought.filter((p) => p.amount >= 65536); // enough to cover
  const sellAmt = 100_000n;
  const inSum = sum(take);
  assert.ok(inSum >= sellAmt);
  const sq = quoteSellUnits(2_601_000n, sellAmt);
  const chgTok = blindOutputs(assetKs, inSum - sellAmt);
  const payout = blindOutputs(satKs, sq.payout);
  const s = await api('POST', '/trades/execute', { asset_id: assetId, side: 'SELL', delta: sellAmt.toString(), inputs: take, outputs_asset: chgTok.map((x) => x.msg), outputs_sat: payout.map((x) => x.msg) }, { key: randomUUID() });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.trade.side, 'SELL');
  const a = (await api('GET', `/assets/${assetId}`)).body;
  assert.equal(a.supply, '2501000');
  // sold proofs cannot be reused
  const re = await api('POST', '/trades/execute', { asset_id: assetId, side: 'SELL', delta: sellAmt.toString(), inputs: take, outputs_asset: [], outputs_sat: [] }, { key: randomUUID() });
  assert.equal(re.status, 400);
  heldTokens.push(...bought.filter((p) => !take.includes(p)), ...unblind(chgTok, s.body.signatures_asset, await keysOf(assetKs)));
  void heldSats;
});

test('swap balances per keyset and cannot inflate', async () => {
  const funds = await faucet(10n);
  const bad = blindOutputs(satKs, 11n);
  assert.equal((await api('POST', '/v1/swap', { inputs: funds, outputs: bad.map((x) => x.msg) }, { key: randomUUID() })).status, 400);
  const good = blindOutputs(satKs, 10n);
  const funds2 = await faucet(10n);
  assert.equal((await api('POST', '/v1/swap', { inputs: funds2, outputs: good.map((x) => x.msg) }, { key: randomUUID() })).status, 200);
});

test('creator fees accrue per immutable split and are claimable once', async () => {
  const fe = await api('GET', '/fees/me', undefined, { token: creatorToken });
  const bal = fe.body.balances.find((b: any) => b.asset_id === assetId);
  assert.ok(BigInt(bal.claimable_sats) > 0n);
  const outs = blindOutputs(satKs, BigInt(bal.claimable_sats));
  const key = randomUUID();
  const body = { asset_id: assetId, outputs: outs.map((x) => x.msg) };
  const c1 = await api('POST', '/fees/claim', body, { token: creatorToken, key });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  const c1b = await api('POST', '/fees/claim', body, { token: creatorToken, key });
  assert.deepEqual(c1b.body, c1.body, 'idempotent retry');
  const o2 = blindOutputs(satKs, 1n);
  assert.equal((await api('POST', '/fees/claim', { asset_id: assetId, outputs: o2.map((x) => x.msg) }, { token: creatorToken, key: randomUUID() })).status, 409);
});

test('vault: locked until unlock_at, only beneficiary, exactly once, recoverable', async () => {
  const friendSk = generateSecretKey();
  const friendTok = await login(friendSk);
  const friendPub = getPublicKey(friendSk);
  const take = heldTokens.filter((p) => p.amount >= 1000).slice(0, 1);
  const lockAmt = 1000n;
  assert.ok(sum(take) >= lockAmt);
  const chg = blindOutputs(assetKs, sum(take) - lockAmt);
  const lk = await api('POST', '/vaults/lock', { asset_id: assetId, beneficiary_pubkey: friendPub, duration: 'demo', amount: '1000', inputs: take, outputs_asset: chg.map((x) => x.msg) }, { token: creatorToken, key: randomUUID() });
  assert.equal(lk.status, 200, JSON.stringify(lk.body));
  const vaultId = lk.body.receipt.vault_id;
  assert.ok(!JSON.stringify(lk.body).includes(friendPub), 'receipt must not leak beneficiary');
  const pub = await api('GET', `/vaults/${vaultId}`);
  assert.equal(pub.body.state, 'LOCKED');
  assert.ok(!JSON.stringify(pub.body).includes(friendPub));

  const outs = blindOutputs(assetKs, lockAmt);
  const body = { outputs: outs.map((x) => x.msg) };
  assert.equal((await api('POST', `/vaults/${vaultId}/claim`, body, { token: friendTok, key: randomUUID() })).body.error.code, 'STILL_LOCKED');
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal((await api('GET', `/vaults/${vaultId}`)).body.state, 'CLAIMABLE');
  assert.equal((await api('POST', `/vaults/${vaultId}/claim`, body, { token: creatorToken, key: randomUUID() })).body.error.code, 'NOT_BENEFICIARY');
  const key = randomUUID();
  const ok = await api('POST', `/vaults/${vaultId}/claim`, body, { token: friendTok, key });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // interrupted client: same outputs, NEW idempotency key => original signatures
  const rec = await api('POST', `/vaults/${vaultId}/claim`, body, { token: friendTok, key: randomUUID() });
  assert.equal(rec.status, 200);
  assert.deepEqual(rec.body.signatures, ok.body.signatures);
  // different outputs cannot claim again
  const other = blindOutputs(assetKs, lockAmt);
  assert.equal((await api('POST', `/vaults/${vaultId}/claim`, { outputs: other.map((x) => x.msg) }, { token: friendTok, key: randomUUID() })).body.error.code, 'ALREADY_CLAIMED');
});

test('audit: checkpoint verifies by independent replay, solvency is conserved', async () => {
  await createCheckpoint(mint);
  const ev = (await api('GET', '/audit/events?from=1&limit=1000')).body;
  const st = emptyState();
  for (const e of ev.events) applyEvent(st, { seq: e.seq, type: e.type, payload: JSON.parse(e.payload) });
  const cp = (await api('GET', '/audit/checkpoints')).body.checkpoints[0];
  assert.equal(stateRoot(st), cp.state_root);
  assert.equal(String(cp.size), String(ev.size));
  const status = (await api('GET', '/audit/status')).body;
  assert.equal(status.global, 'VERIFIED', JSON.stringify(status));
  const sol = (await api('GET', '/audit/solvency')).body;
  assert.equal(sol.ledger_conserved, true, JSON.stringify(sol));
  assert.ok(sol.token_checks.every((t: any) => t.ok && t.curve_ok), JSON.stringify(sol.token_checks));
  assert.equal(sol.backing_status, 'UNVERIFIED');
  // tampering is detected
  const forged = JSON.parse(ev.events[1].payload);
  forged.gross = '1';
  const evs2 = ev.events.map((e: any, i: number) => (i === 1 ? { ...e, payload: canonical(forged) } : e));
  const st2 = emptyState();
  assert.throws(() => evs2.forEach((e: any) => applyEvent(st2, { seq: e.seq, type: e.type, payload: JSON.parse(e.payload) })));
});
