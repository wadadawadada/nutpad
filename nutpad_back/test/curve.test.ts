import test from 'node:test';
import assert from 'node:assert/strict';
import { C, distribute, feeOf, quoteBuyBudget, quoteBuyUnits, quoteSellUnits, splitFee, SUPPLY } from '../src/curve.js';
import { consistencyProof, inclusionProof, leafHash, mth, verifyConsistency, verifyInclusion } from '../src/merkle.js';

test('curve endpoints', () => {
  assert.equal(C(0n), 0n);
  assert.equal(C(SUPPLY), 1_000_000n);
});

test('spec test vector: first buy of 10% supply', () => {
  const q = quoteBuyUnits(0n, 2_100_000n);
  assert.equal(q.gross, 11_890n);
  assert.equal(q.fee, 119n);
  assert.equal(q.total, 12_009n);
  const s = splitFee(q.fee);
  assert.equal(s.platform, 83n);
  assert.equal(s.creatorPool, 36n);
});

test('buy then sell back: reserve returns to curve, fee never from reserve', () => {
  for (const [q, d] of [[0n, 1000n], [5_000_000n, 777_777n], [20_999_000n, 1000n], [0n, SUPPLY]] as const) {
    const b = quoteBuyUnits(q, d);
    assert.equal(C(q + d) - C(q), b.gross);
    if (q + d > 0n && b.gross > b.fee) {
      const s = quoteSellUnits(q + d, d);
      assert.equal(s.gross, b.gross);
      assert.equal(s.payout, s.gross - s.fee);
    }
  }
});

test('C is monotone and increments sum to totals (property)', () => {
  let prev = 0n;
  for (let q = 0n; q <= SUPPLY; q += 104_729n) {
    const c = C(q);
    assert.ok(c >= prev);
    prev = c;
  }
  // additivity: buy in pieces == buy at once
  const pieces = [123_456n, 7n, 999_999n, 1n, 4_000_000n];
  let q = 0n, sum = 0n;
  for (const p of pieces) { sum += C(q + p) - C(q); q += p; }
  assert.equal(sum, C(q));
});

test('fee split and distribution never lose sats', () => {
  for (let fee = 1n; fee < 400n; fee++) {
    const s = splitFee(fee);
    assert.equal(s.platform + s.creatorPool, fee);
    for (const w of [[10000], [5000, 5000], [3333, 3333, 3334], [1, 9999], [2500, 2500, 2500, 2500]]) {
      const parts = distribute(s.creatorPool, w);
      assert.equal(parts.reduce((a, b) => a + b, 0n), s.creatorPool);
    }
  }
  assert.equal(feeOf(1n), 1n);
});

test('quoteBuyBudget never exceeds the budget and is maximal', () => {
  for (const [q, budget] of [[0n, 100n], [0n, 12_009n], [3_000_000n, 5000n]] as const) {
    const r = quoteBuyBudget(q, budget)!;
    assert.ok(r.total <= budget);
    const more = quoteBuyUnits(q, r.delta + 1n);
    assert.ok(more.total > budget);
  }
});

test('merkle inclusion and consistency proofs (RFC 6962)', () => {
  const leaves = Array.from({ length: 33 }, (_, i) => leafHash(new Uint8Array([i])));
  for (let n = 1; n <= leaves.length; n++) {
    const part = leaves.slice(0, n);
    const root = mth(part);
    for (let i = 0; i < n; i++) assert.ok(verifyInclusion(part[i], i, n, inclusionProof(part, i), root), `incl ${i}/${n}`);
    for (let m = 1; m <= n; m++)
      assert.ok(verifyConsistency(m, n, consistencyProof(leaves, m, n), mth(leaves.slice(0, m)), root), `cons ${m}->${n}`);
  }
  // tamper detection
  const root = mth(leaves.slice(0, 8));
  assert.ok(!verifyInclusion(leaves[3], 4, 8, inclusionProof(leaves.slice(0, 8), 3), root));
});
