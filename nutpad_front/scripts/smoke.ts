// Node smoke test for the browser wallet logic against a running API (default http://localhost:8787).
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
(globalThis as any).window = { location: { origin: 'http://localhost:5173' }, open() {} };

const { burnerSigner, loginWith } = await import('../src/lib/nostr');
const W = await import('../src/lib/wallet');
const { api } = await import('../src/lib/api');
const { sha256 } = await import('@noble/hashes/sha2.js');
const { bytesToHex } = await import('@noble/hashes/utils.js');
const { quoteBuyBudget } = await import('../src/lib/curve');

const ok = (c: boolean, m: string) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) process.exitCode = 1; };

await W.refreshKeysets();
const sat = await W.satKeysetId();
await W.faucet(20000);
ok(W.balanceOf(sat) === 20000, 'faucet 20000');

const signer = burnerSigner();
const { pubkey } = await loginWith(signer);
const info = await api('GET', '/v1/info');
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const manifest = {
  v: 1, nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))), issuer: info.pubkey, creator: pubkey, name: 'Smoke', ticker: 'SMK', description: 'node smoke',
  image_hash: bytesToHex(sha256(png)), image_mime: 'image/png', supply: '21000000',
  curve: { type: 'linear', start_price_nano: '1000000', reserve_total: '1000000' }, fee_split: [{ pubkey, bps: 10000 }],
  launch: { fee_sats: '1000', min_first_buy_sats: '100', max_first_buy_units: '2100000' },
};
const first = quoteBuyBudget(0n, 5000n, 2_100_000n)!;
const q = await api('POST', '/assets/launch/quote', { manifest, units: first.delta.toString() });
const ev = await signer.signEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', manifest.nonce]], content: q.content });
const total = Number(first.total) + 1000;
const inputs = W.selectProofs(sat, total);
const inSum = inputs.reduce((a, p) => a + p.amount, 0);
const r = await W.runOp({ kind: 'launch', path: '/assets/launch', inputs,
  extra: { manifest_event: ev, image_b64: Buffer.from(png).toString('base64'), delta: first.delta.toString() },
  groups: [{ name: 'asset', keysetId: q.keyset_id, field: 'signatures_asset', total: first.delta }, { name: 'sat', keysetId: sat, field: 'signatures_sat', total: inSum - total }] });
const assetId = r.response.asset_id as string;
ok(W.balanceOf(q.keyset_id) === Number(first.delta), `launched, holding ${first.delta} units`);
ok(W.balanceOf(sat) === 20000 - total, 'sat balance after launch');

await W.trade(assetId, q.keyset_id, 'BUY', { sats: 3000n });
const afterBuy = W.balanceOf(q.keyset_id);
ok(afterBuy > Number(first.delta), 'bought more');
await W.trade(assetId, q.keyset_id, 'SELL', { units: BigInt(Math.floor(afterBuy / 3)) });
ok(W.balanceOf(q.keyset_id) === afterBuy - Math.floor(afterBuy / 3), 'sold a third');

const tok = await W.sendToken(q.keyset_id, 12345);
ok(W.balanceOf(q.keyset_id) === afterBuy - Math.floor(afterBuy / 3) - 12345, 'token created, balance reduced');
const got = await W.receiveToken(tok);
ok(got.amount === 12345, 'token redeemed');
ok(W.balanceOf(q.keyset_id) === afterBuy - Math.floor(afterBuy / 3), 'balance restored after redeem');
let dbl = false;
try { await W.receiveToken(tok); } catch { dbl = true; }
ok(dbl, 'redeeming the same token twice is rejected');

const before = { sat: W.balanceOf(sat), tok: W.balanceOf(q.keyset_id) };
const seed = W.walletSeed();
const rec = await W.restoreFromSeed(seed);
console.log(before, W.balanceOf(sat), W.balanceOf(q.keyset_id));
ok(W.balanceOf(sat) === before.sat && W.balanceOf(q.keyset_id) === before.tok, `restore from seed recovered balances (${rec.recovered} proofs)`);
const solv = await api('GET', '/audit/solvency');
ok(solv.ledger_conserved === true && solv.token_checks.every((t: any) => t.ok && t.curve_ok), 'server solvency/invariants consistent');
