// Remove all launched tokens and the public audit log, keeping the mint identity and the treasury.
//   npm run reset:tokens -- --yes        (STOP the running backend first: PGlite allows one process)
//
// What is kept on purpose:
//  - meta (mint seed in dev), keysets of the sat unit, treasury_* / upstream_* (the Lightning wallet)
//  - `proofs` and `outgoing_signatures`: the spent-proof set must never shrink, otherwise already
//    spent ecash would become spendable again.
// Sats that sat in curve reserves / fee balances of the deleted tokens become operator surplus and are
// recorded as `ledger_written_off` so the solvency conservation check still balances.
import { openDb, big } from './db.js';

if (!process.argv.includes('--yes')) {
  console.log('This deletes ALL launched tokens, trades, vaults, fee balances and the audit log.');
  console.log('Re-run with --yes to confirm (stop the backend first).');
  process.exit(1);
}

const db = await openDb();
const before = await db.query<any>(`SELECT COUNT(*) AS n, COALESCE(SUM(reserve_sats),0) AS r, COALESCE(SUM(creator_fee_accrued - creator_fee_claimed),0) AS f FROM assets`);
const plat = await db.query<any>(`SELECT fees_sats FROM platform_ledger WHERE id=1`);
const writtenOff = big(before.rows[0].r) + big(before.rows[0].f) + big(plat.rows[0].fees_sats);

await db.tx(async (c) => {
  for (const t of ['vaults', 'claims', 'fee_balances', 'fee_allocations', 'trades', 'launches', 'assets', 'audit_events', 'audit_checkpoints', 'outbox', 'idempotency_keys'])
    await c.query(`DELETE FROM ${t}`);
  await c.query(`DELETE FROM keysets WHERE asset_id IS NOT NULL`);
  await c.query(`UPDATE platform_ledger SET fees_sats=0 WHERE id=1`);
  await c.query(`UPDATE audit_head SET size=0 WHERE id=1`);
  await c.query(
    `INSERT INTO meta(key,value) VALUES('ledger_written_off',$1)
     ON CONFLICT (key) DO UPDATE SET value=(meta.value::bigint + $1::bigint)::text`,
    [writtenOff.toString()],
  );
});
console.log(`Removed ${before.rows[0].n} token(s). ${writtenOff} sats of reserves/fees written off as operator surplus.`);
await db.close();
