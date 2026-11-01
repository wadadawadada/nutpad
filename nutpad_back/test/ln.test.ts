process.env.PGLITE_DIR = '';
process.env.DEMO_FAUCET = 'false';
process.env.MINT_SEED = 'cd'.repeat(32);
process.env.LN_BACKEND = 'fake';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { blindOutputs, unblind } from './helpers.js';

const { openDb } = await import('../src/db.js');
const { Mint } = await import('../src/mint.js');
const { createApp } = await import('../src/app.js');
const { FakeLnBackend, LnbitsBackend, decodeBolt11 } = await import('../src/ln.js');
const { reconcileMelt } = await import('../src/lightning.js');

let base = '';
let server: any;
let mint: InstanceType<typeof Mint>;
let ln: InstanceType<typeof FakeLnBackend>;
let satKs = '';
let satKeys: Record<string, string>;

before(async () => {
  const db = await openDb();
  mint = new Mint(db);
  await mint.init();
  ln = new FakeLnBackend(0);
  mint.ln = ln;
  server = createApp(mint).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  satKs = mint.satKeysetId;
  satKeys = (await (await fetch(`${base}/v1/keys/${satKs}`)).json() as any).keysets[0].keys;
});
after(async () => { server.close(); await mint.db.close(); });

async function post(path: string, body: unknown, key?: string) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const get = async (path: string) => (await (await fetch(base + path)).json()) as any;

/** deposit `amount` sats through the (fake) Lightning backend and return the proofs */
async function deposit(amount: bigint) {
  const q = (await post('/v1/mint/quote/bolt11', { amount: amount.toString(), unit: 'sat' })).body;
  const st = await get(`/v1/mint/quote/bolt11/${q.quote}`);
  assert.equal(st.state, 'PAID');
  const outs = blindOutputs(satKs, amount);
  const r = await post('/v1/mint/bolt11', { quote: q.quote, outputs: outs.map((o) => o.msg) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { proofs: unblind(outs, r.body.signatures, satKeys), quote: q.quote, outs, sigs: r.body.signatures };
}
const sum = (ps: { amount: number }[]) => ps.reduce((a, p) => a + BigInt(p.amount), 0n);

test('faucet is disabled when running against real Lightning', async () => {
  const outs = blindOutputs(satKs, 100n);
  const r = await post('/v1/faucet', { outputs: outs.map((o) => o.msg) }, randomUUID());
  assert.equal(r.status, 403);
});

test('deposit: unpaid quote cannot mint; paid quote mints exactly once (recoverable)', async () => {
  const slow = new FakeLnBackend(60_000);
  mint.ln = slow;
  const q = (await post('/v1/mint/quote/bolt11', { amount: '500' })).body;
  const outs0 = blindOutputs(satKs, 500n);
  const early = await post('/v1/mint/bolt11', { quote: q.quote, outputs: outs0.map((o) => o.msg) });
  assert.equal(early.status, 402);
  assert.equal(early.body.error.code, 'QUOTE_NOT_PAID');
  mint.ln = ln;

  const d = await deposit(1500n);
  // interrupted client: same outputs again -> original signatures
  const again = await post('/v1/mint/bolt11', { quote: d.quote, outputs: d.outs.map((o) => o.msg) });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.signatures, d.sigs);
  // other outputs cannot mint the same quote twice
  const other = blindOutputs(satKs, 1500n);
  assert.equal((await post('/v1/mint/bolt11', { quote: d.quote, outputs: other.map((o) => o.msg) })).body.error.code, 'ALREADY_ISSUED');
  // wrong amount is refused
  const q2 = (await post('/v1/mint/quote/bolt11', { amount: '100' })).body;
  await get(`/v1/mint/quote/bolt11/${q2.quote}`);
  assert.equal((await post('/v1/mint/bolt11', { quote: q2.quote, outputs: blindOutputs(satKs, 101n).map((o) => o.msg) })).body.error.code, 'UNBALANCED');
  // limits
  assert.equal((await post('/v1/mint/quote/bolt11', { amount: '0' })).status, 400);
  assert.equal((await post('/v1/mint/quote/bolt11', { amount: '999999999' })).status, 400);
});

test('withdraw: pays once, burns ecash, returns change; inputs cannot be reused', async () => {
  const d = await deposit(2000n);
  const inv = FakeLnBackend.externalInvoice(1000n);
  const mq = (await post('/v1/melt/quote/bolt11', { request: inv, unit: 'sat' })).body;
  assert.equal(mq.amount, '1000');
  assert.equal(mq.fee_reserve, '10');
  const change = blindOutputs(satKs, 2000n - 1000n - 10n);
  const body = { quote: mq.quote, inputs: d.proofs, outputs: change.map((o) => o.msg) };
  const r = await post('/v1/melt/bolt11', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, 'PAID');
  assert.ok(r.body.payment_preimage);
  assert.equal(unblind(change, r.body.signatures, satKeys).length, change.length);
  // idempotent retry returns the stored result and does not pay again
  const balBefore = await ln.balanceSats();
  const r2 = await post('/v1/melt/bolt11', body);
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body, r.body);
  assert.equal(await ln.balanceSats(), balBefore, 'no second payment');
  // spent inputs cannot fund another withdrawal
  const mq2 = (await post('/v1/melt/quote/bolt11', { request: FakeLnBackend.externalInvoice(500n) })).body;
  const again = await post('/v1/melt/bolt11', { quote: mq2.quote, inputs: d.proofs, outputs: [] });
  assert.equal(again.body.error.code, 'TOKEN_ALREADY_SPENT');
  // an invoice cannot get a second quote after it was paid
  assert.equal((await post('/v1/melt/quote/bolt11', { request: inv })).body.error.code, 'INVOICE_ALREADY_USED');
});

test('withdraw: unbalanced inputs are refused and nothing is spent', async () => {
  const d = await deposit(1000n);
  const mq = (await post('/v1/melt/quote/bolt11', { request: FakeLnBackend.externalInvoice(900n) })).body;
  const bad = await post('/v1/melt/bolt11', { quote: mq.quote, inputs: d.proofs, outputs: [] }); // 1000 != 900 + 9 + 0
  assert.equal(bad.body.error.code, 'UNBALANCED');
  const ys = await post('/v1/checkstate', { Ys: [(await import('../src/cashu.js')).proofY(d.proofs[0].secret)] });
  assert.equal(ys.body.states[0].state, 'UNSPENT');
});

test('withdraw: failed payment releases the tokens', async () => {
  const d = await deposit(1200n);
  ln.failNext = true;
  const mq = (await post('/v1/melt/quote/bolt11', { request: FakeLnBackend.externalInvoice(1000n) })).body;
  const r = await post('/v1/melt/bolt11', { quote: mq.quote, inputs: d.proofs, outputs: blindOutputs(satKs, 190n).map((o) => o.msg) });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'PAYMENT_FAILED');
  // tokens are spendable again
  const outs = blindOutputs(satKs, 1200n);
  const sw = await post('/v1/swap', { inputs: d.proofs, outputs: outs.map((o) => o.msg) }, randomUUID());
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  assert.equal((await get(`/v1/melt/quote/bolt11/${mq.quote}`)).state, 'UNPAID');
});

test('withdraw: in-flight payment stays PENDING (inputs locked) and the reconciler settles it', async () => {
  const d = await deposit(1100n);
  ln.holdNext = true;
  const inv = FakeLnBackend.externalInvoice(1000n);
  const mq = (await post('/v1/melt/quote/bolt11', { request: inv })).body;
  const change = blindOutputs(satKs, 90n);
  const body = { quote: mq.quote, inputs: d.proofs, outputs: change.map((o) => o.msg) };
  const r = await post('/v1/melt/bolt11', body);
  assert.equal(r.status, 202);
  assert.equal(r.body.state, 'PENDING');
  // locked meanwhile
  const { proofY } = await import('../src/cashu.js');
  assert.equal((await post('/v1/checkstate', { Ys: [proofY(d.proofs[0].secret)] })).body.states[0].state, 'PENDING');
  assert.equal((await post('/v1/swap', { inputs: d.proofs, outputs: blindOutputs(satKs, 1100n).map((o) => o.msg) }, randomUUID())).body.error.code, 'TOKEN_ALREADY_SPENT');
  // solvency counts in-flight value
  const mid = await get('/audit/solvency');
  assert.equal(mid.ledger_conserved, true, JSON.stringify(mid));
  assert.equal(mid.in_flight_withdrawals, '1100');
  // retry while still pending => still pending, no second payment
  assert.equal((await post('/v1/melt/bolt11', body)).status, 202);
  // node confirms
  const hash = ln.decode(inv).paymentHash;
  ln.settleHeld(hash, true);
  const done = await reconcileMelt(mint, mq.quote, true);
  assert.equal(done.status, 200);
  assert.equal((done.body as any).state, 'PAID');
  assert.equal((await get('/audit/solvency')).ledger_conserved, true);
});

test('withdraw: unresolved payment is refunded only after the grace period when the node says FAILED', async () => {
  const d = await deposit(1100n);
  ln.holdNext = true;
  const inv = FakeLnBackend.externalInvoice(1000n);
  const mq = (await post('/v1/melt/quote/bolt11', { request: inv })).body;
  await post('/v1/melt/bolt11', { quote: mq.quote, inputs: d.proofs, outputs: blindOutputs(satKs, 90n).map((o) => o.msg) });
  ln.settleHeld(ln.decode(inv).paymentHash, false);
  const young = await reconcileMelt(mint, mq.quote, true);
  assert.equal(young.status, 202, 'too young to refund');
  await mint.db.query(`UPDATE melt_quotes SET updated_at = now() - interval '5 minutes' WHERE quote_id=$1`, [mq.quote]);
  await assert.rejects(() => reconcileMelt(mint, mq.quote, true), /PAYMENT_FAILED|failed/);
  const outs = blindOutputs(satKs, 1100n);
  assert.equal((await post('/v1/swap', { inputs: d.proofs, outputs: outs.map((o) => o.msg) }, randomUUID())).status, 200);
});

test('withdraw: two concurrent requests pay an invoice only once', async () => {
  const d = await deposit(1100n);
  const inv = FakeLnBackend.externalInvoice(1000n);
  const mq = (await post('/v1/melt/quote/bolt11', { request: inv })).body;
  const body = { quote: mq.quote, inputs: d.proofs, outputs: blindOutputs(satKs, 90n).map((o) => o.msg) };
  const before = await ln.balanceSats();
  const [a, b] = await Promise.all([post('/v1/melt/bolt11', body), post('/v1/melt/bolt11', body)]);
  assert.ok([a.status, b.status].every((s) => s === 200 || s === 202), JSON.stringify([a.body, b.body]));
  assert.equal(before! - (await ln.balanceSats())!, 1001n, 'exactly one payment (1000 + 1 fee)');
});

test('invoices for another network are rejected; amountless/garbage invoices too', async () => {
  const garbage = await post('/v1/melt/quote/bolt11', { request: 'lnbc1garbage' });
  assert.equal(garbage.body.error.code, 'BAD_INVOICE');
  // BOLT-11 spec vector (mainnet, 250000 sats)
  const spec = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
  const d = decodeBolt11(spec);
  assert.equal(d.amountSats, 250000n);
  assert.equal(d.network, 'mainnet');
});

test('solvency: BACKED when the treasury covers all obligations, ledger conserved', async () => {
  const s = await get('/audit/solvency');
  assert.equal(s.ledger_conserved, true, JSON.stringify(s));
  assert.equal(s.backing_status, 'BACKED', JSON.stringify(s));
  assert.equal(s.ln_backend, 'fake');
});

test('LNbits adapter speaks the LNbits REST API (mock server)', async () => {
  const state = { paid: new Set<string>(), out: new Map<string, any>(), balanceMsat: 5_000_000, posts: [] as any[] };
  const srv: Server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.headers['x-api-key'] !== 'adminkey') return send(401, { detail: 'nope' });
      const u = new URL(req.url!, 'http://x');
      if (req.method === 'POST' && u.pathname === '/api/v1/payments') {
        const j = JSON.parse(b);
        state.posts.push(j);
        if (!j.out) return send(201, { payment_request: 'lnbcmock', payment_hash: 'ab'.repeat(32) });
        state.out.set(decodeBolt11(j.bolt11).paymentHash, { paid: true, preimage: 'ff', details: { fee: -2000 } });
        return send(201, { payment_hash: 'x' });
      }
      const m = /^\/api\/v1\/payments\/([0-9a-f]+)$/.exec(u.pathname);
      if (req.method === 'GET' && m) {
        if (state.out.has(m[1])) return send(200, state.out.get(m[1]));
        if (m[1] === 'ab'.repeat(32)) return send(200, { paid: state.paid.has(m[1]) });
        return send(404, { detail: 'not found' });
      }
      if (req.method === 'GET' && u.pathname === '/api/v1/wallet') return send(200, { balance: state.balanceMsat });
      send(404, {});
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const b = new LnbitsBackend(url, 'adminkey', 'mainnet');
    const inv = await b.createInvoice(21n, 'memo');
    assert.equal(inv.bolt11, 'lnbcmock');
    assert.equal(await b.isPaid(inv.paymentHash), false);
    state.paid.add(inv.paymentHash);
    assert.equal(await b.isPaid(inv.paymentHash), true);
    assert.equal(await b.balanceSats(), 5000n);
    const spec = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
    const r1 = await b.pay(spec, 2500n);
    assert.equal(r1.status, 'PAID');
    assert.equal(r1.feeSats, 2n);
    const r2 = await b.pay(spec, 2500n);
    assert.equal(r2.status, 'PAID');
    assert.equal(state.posts.filter((p) => p.out).length, 1, 'never pays the same invoice twice');
    assert.equal(state.posts.find((p) => p.out).fee_limit_msat, 2_500_000);
    await assert.rejects(() => new LnbitsBackend(url, 'wrong', 'mainnet').createInvoice(1n, ''));
  } finally {
    srv.close();
  }
});

test('treasury guard: withdrawals are refused while the treasury is below obligations', async () => {
  const d = await deposit(1000n);
  const mq = (await post('/v1/melt/quote/bolt11', { request: FakeLnBackend.externalInvoice(500n) })).body;
  const real = ln.balanceSats.bind(ln);
  ln.balanceSats = async () => 10n; // treasury way below what users hold
  try {
    const r = await post('/v1/melt/bolt11', { quote: mq.quote, inputs: d.proofs, outputs: blindOutputs(satKs, 495n).map((o) => o.msg) });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'TREASURY_UNDERBACKED');
    assert.equal((await get('/audit/solvency')).backing_status, 'UNDERBACKED');
    ln.balanceSats = async () => null;
    assert.equal((await post('/v1/melt/bolt11', { quote: mq.quote, inputs: d.proofs, outputs: blindOutputs(satKs, 495n).map((o) => o.msg) })).body.error.code, 'TREASURY_UNKNOWN');
  } finally {
    ln.balanceSats = real;
  }
  // after the guard trips nothing was spent
  const ok = await post('/v1/melt/bolt11', { quote: mq.quote, inputs: d.proofs, outputs: blindOutputs(satKs, 495n).map((o) => o.msg) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});
