// Deposit/withdraw smoke test against a backend running LN_BACKEND=fake (see README).
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
(globalThis as any).window = { location: { origin: 'http://localhost:5173' }, open() {} };
const W = await import('../src/lib/wallet');
const ok = (c: boolean, m: string) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) process.exitCode = 1; };
await W.refreshKeysets();
const sat = await W.satKeysetId();

const d = await W.createDeposit(3000);
ok(d.request.startsWith('lnfake1_'), 'invoice created');
let st = await W.settleDeposit(d);
for (let i = 0; i < 10 && st !== 'DONE'; i++) { await new Promise((r) => setTimeout(r, 1000)); st = await W.settleDeposit(d); }
ok(st === 'DONE' && W.balanceOf(sat) === 3000, `deposit minted 3000 sats (${st})`);
ok(W.balanceOf(sat) === 3000 && (await W.checkDeposits(), true), 'no deposits left pending');

const inv = `lnfake1_1000_${'ab'.repeat(32)}`;
const q = await W.meltQuote(inv);
ok(q.amount === '1000' && q.fee_reserve === '10', 'melt quote 1000 + 10');
const r = await W.withdraw(q);
ok(r.response.state === 'PAID' && W.balanceOf(sat) === 3000 - 1010 + 0 + (3000 - 1010 - (3000 - 1010)), 'withdraw paid');
console.log('balance after withdraw', W.balanceOf(sat));
ok(W.balanceOf(sat) === 1990, 'change returned (3000 - 1010)');
let bad = false; try { await W.meltQuote(inv); } catch { bad = true; }
ok(bad, 'same invoice cannot be quoted twice');
