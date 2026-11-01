import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import { NwcBackend, parseNwcUrl } from '../src/nwc.js';
import { decodeBolt11 } from '../src/ln.js';

// BOLT-11 spec vector: 250000 sats
const INV = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
const HASH = decodeBolt11(INV).paymentHash;

/* ---- tiny in-memory Nostr relay ---- */
const events: Event[] = [];
const subs = new Set<{ ws: WebSocket; id: string; f: any }>();
const matches = (f: any, e: Event) =>
  (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) &&
  (!f['#e'] || e.tags.some((t) => t[0] === 'e' && f['#e'].includes(t[1]))) &&
  (!f['#p'] || e.tags.some((t) => t[0] === 'p' && f['#p'].includes(t[1])));
let relay: WebSocketServer;

/* ---- mock wallet service ---- */
const walletSk = generateSecretKey();
const walletPk = getPublicKey(walletSk);
const clientSk = generateSecretKey();
const clientPk = getPublicKey(clientSk);
const W = { incoming: true, paid: false, calls: [] as string[], balanceMsat: 7_000_000, refuse: false, silent: false, outgoing: new Map<string, any>() };
let walletWs: WebSocket;
let mode: 'nip04' | 'nip44_v2' = 'nip04';

const dec = (e: Event) => (e.tags.some((t) => t[0] === 'encryption' && t[1] === 'nip44_v2')
  ? nip44.decrypt(e.content, nip44.getConversationKey(walletSk, e.pubkey)) : nip04.decrypt(walletSk, e.pubkey, e.content));
const enc = (text: string, to: string, m: string) => (m === 'nip44_v2' ? nip44.encrypt(text, nip44.getConversationKey(walletSk, to)) : nip04.encrypt(walletSk, to, text));

function publishInfo() {
  const info = finalizeEvent({ kind: 13194, created_at: Math.floor(Date.now() / 1000), tags: mode === 'nip44_v2' ? [['encryption', 'nip44_v2 nip04']] : [], content: 'make_invoice lookup_invoice pay_invoice get_balance' }, walletSk);
  events.length = 0;
  events.push(info);
}

before(async () => {
  relay = new WebSocketServer({ port: 0 });
  relay.on('connection', (ws) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m[0] === 'REQ') {
        const s = { ws, id: m[1], f: m[2] };
        subs.add(s);
        for (const e of events) if (matches(s.f, e)) ws.send(JSON.stringify(['EVENT', s.id, e]));
        ws.send(JSON.stringify(['EOSE', s.id]));
      } else if (m[0] === 'EVENT') {
        const e = m[1] as Event;
        if (!verifyEvent(e)) return ws.send(JSON.stringify(['OK', e.id, false, 'invalid']));
        events.push(e);
        ws.send(JSON.stringify(['OK', e.id, true, '']));
        for (const s of subs) if (s.ws.readyState === 1 && matches(s.f, e)) s.ws.send(JSON.stringify(['EVENT', s.id, e]));
      }
    });
    ws.on('close', () => { for (const s of subs) if (s.ws === ws) subs.delete(s); });
  });
  await new Promise((r) => relay.once('listening', r));
  const url = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  (globalThis as any).__relay = url;

  // the mock wallet is a relay client
  walletWs = new WebSocket(url);
  await new Promise((r) => walletWs.once('open', r));
  walletWs.send(JSON.stringify(['REQ', 'w', { kinds: [23194], '#p': [walletPk] }]));
  walletWs.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m[0] !== 'EVENT') return;
    const req = m[2] as Event;
    const { method, params } = JSON.parse(dec(req));
    W.calls.push(method);
    if (W.silent) return;
    const m2 = req.tags.some((t) => t[0] === 'encryption') ? 'nip44_v2' : 'nip04';
    let body: any;
    if (method === 'make_invoice') body = { result_type: method, result: { invoice: INV, payment_hash: HASH } };
    else if (method === 'lookup_invoice') {
      const out = W.outgoing.get(params.payment_hash);
      body = out ? { result_type: method, result: out }
        : params.payment_hash === HASH && W.paid ? { result_type: method, result: { state: 'settled', settled_at: 1, preimage: 'aa' } }
        : params.payment_hash === HASH && W.incoming ? { result_type: method, result: { state: 'pending' } }
        : { result_type: method, error: { code: 'NOT_FOUND', message: 'nope' } };
    } else if (method === 'pay_invoice') {
      if (W.refuse) body = { result_type: method, error: { code: 'INSUFFICIENT_BALANCE', message: 'no funds' } };
      else { W.outgoing.set(decodeBolt11(params.invoice).paymentHash, { state: 'settled', preimage: 'bb', fees_paid: 3000 }); body = { result_type: method, result: { preimage: 'bb', fees_paid: 3000 } }; }
    } else if (method === 'get_balance') body = { result_type: method, result: { balance: W.balanceMsat } };
    else body = { result_type: method, error: { code: 'NOT_IMPLEMENTED', message: method } };
    const resp = finalizeEvent({ kind: 23195, created_at: Math.floor(Date.now() / 1000), tags: [['e', req.id], ['p', req.pubkey]], content: enc(JSON.stringify(body), req.pubkey, m2) }, walletSk);
    walletWs.send(JSON.stringify(['EVENT', resp]));
  });
});
after(() => { walletWs.close(); relay.close(); });

const backend = (timeout = 5000) =>
  new NwcBackend(parseNwcUrl(`nostr+walletconnect://${walletPk}?relay=${encodeURIComponent((globalThis as any).__relay)}&secret=${bytesToHex(clientSk)}`), 'mainnet', timeout);
const reset = () => { W.incoming = true; W.paid = false; W.calls = []; W.refuse = false; W.silent = false; W.outgoing.clear(); };

for (const m of ['nip04', 'nip44_v2'] as const) {
  test(`NWC (${m}): invoice, paid-detection, balance, pay exactly once`, async () => {
    mode = m; reset(); publishInfo();
    const b = backend();
    const inv = await b.createInvoice(250000n, 'deposit');
    assert.equal(inv.bolt11, INV);
    assert.equal(inv.paymentHash, HASH);
    assert.equal(await b.isPaid(HASH), false);
    W.paid = true;
    assert.equal(await b.isPaid(HASH), true);
    assert.equal(await b.balanceSats(), 7000n);
    W.paid = false;
    W.incoming = false; // from here on the invoice is one we PAY (outgoing), not one we issued
    const r1 = await b.pay(INV, 3000n);
    assert.equal(r1.status, 'PAID');
    assert.equal(r1.feeSats, 3n);
    const r2 = await b.pay(INV, 3000n);
    assert.equal(r2.status, 'PAID');
    assert.equal(W.calls.filter((c) => c === 'pay_invoice').length, 1, 'never pays the same invoice twice');
  });
}

test('NWC: wallet refusal => FAILED; silence => throws (unknown outcome, caller keeps it PENDING)', async () => {
  mode = 'nip04'; reset(); publishInfo();
  W.refuse = true;
  W.incoming = false;
  assert.equal((await backend().pay(INV, 3000n)).status, 'FAILED');
  reset();
  W.silent = true;
  W.incoming = false;
  await assert.rejects(() => backend(600).pay(INV, 3000n), /no response/);
  // wrong amount returned by a wallet is rejected
  reset();
  await assert.rejects(() => backend().createInvoice(1n, 'x'), /different amount/);
});

test('parseNwcUrl validates its input', () => {
  assert.throws(() => parseNwcUrl('https://example.com'));
  assert.throws(() => parseNwcUrl(`nostr+walletconnect://${walletPk}?secret=${'a'.repeat(64)}`), /relay/);
  const c = parseNwcUrl(`nostr+walletconnect://${walletPk}?relay=wss%3A%2F%2Fr.example&secret=${'a'.repeat(64)}`);
  assert.deepEqual(c.relays, ['wss://r.example']);
});
