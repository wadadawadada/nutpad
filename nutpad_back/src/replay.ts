// Deterministic state-transition rules for the public audit log.
// Shared by the server (state root) and the independent verifier.
import { C, distribute, feeOf, quoteBuyUnits, quoteSellUnits, splitFee, SUPPLY } from './curve.js';
import { canonical, sha256Hex } from './util.js';

export interface AssetState {
  supply: bigint;
  reserve: bigint;
  locked: bigint;
  feeAccrued: bigint;
  feeClaimed: bigint;
  split: { pubkey: string; bps: number }[];
  tradeSeq: bigint;
  vaults: Map<string, { amount: bigint; unlockAt: number; claimed: boolean }>;
}

export interface LogState {
  assets: Map<string, AssetState>;
  platformFees: bigint;
}

export const emptyState = (): LogState => ({ assets: new Map(), platformFees: 0n });

export interface LogEvent {
  seq: number;
  type: string;
  payload: any;
}

class ReplayError extends Error {}
const need = (cond: boolean, msg: string) => {
  if (!cond) throw new ReplayError(msg);
};

export function applyEvent(s: LogState, ev: LogEvent): void {
  const p = ev.payload;
  const asset = () => {
    const a = s.assets.get(p.asset_id);
    need(!!a, `unknown asset ${p.asset_id}`);
    return a!;
  };
  switch (ev.type) {
    case 'LAUNCH': {
      need(!s.assets.has(p.asset_id), 'duplicate launch');
      const bps = (p.fee_split as { bps: number }[]).reduce((x, y) => x + y.bps, 0);
      need(bps === 10000, 'fee split must sum to 10000');
      need(BigInt(p.launch_fee) === 1000n, 'launch fee must be 1000');
      s.assets.set(p.asset_id, {
        supply: 0n,
        reserve: 0n,
        locked: 0n,
        feeAccrued: 0n,
        feeClaimed: 0n,
        split: p.fee_split,
        tradeSeq: 0n,
        vaults: new Map(),
      });
      s.platformFees += 1000n;
      return;
    }
    case 'BUY':
    case 'SELL': {
      const a = asset();
      const delta = BigInt(p.delta);
      need(BigInt(p.seq) === a.tradeSeq + 1n, 'trade seq gap');
      a.tradeSeq += 1n;
      let gross: bigint, fee: bigint;
      if (ev.type === 'BUY') {
        const q = quoteBuyUnits(a.supply, delta);
        gross = q.gross;
        fee = q.fee;
        a.supply += delta;
        a.reserve += gross;
        if (a.tradeSeq === 1n) need(delta <= SUPPLY / 10n, 'first buy exceeds 10%');
      } else {
        need(delta <= a.supply, 'sell exceeds supply');
        const q = quoteSellUnits(a.supply, delta);
        gross = q.gross;
        fee = q.fee;
        a.supply -= delta;
        a.reserve -= gross;
      }
      need(gross === BigInt(p.gross) && fee === BigInt(p.fee) && fee === feeOf(gross), 'gross/fee mismatch');
      need(a.reserve === C(a.supply), 'reserve != C(supply)');
      need(a.supply === BigInt(p.supply_after) && a.reserve === BigInt(p.reserve_after), 'state_after mismatch');
      need(a.locked <= a.supply, 'locked > supply');
      const { platform, creatorPool } = splitFee(fee);
      need(BigInt(p.fee_platform) === platform && BigInt(p.fee_creator) === creatorPool, 'fee split mismatch');
      const parts = distribute(creatorPool, a.split.map((x) => x.bps));
      need(
        canonical(p.creator_split) === canonical(a.split.map((x, i) => ({ pubkey: x.pubkey, sats: parts[i] }))),
        'creator split mismatch',
      );
      a.feeAccrued += creatorPool;
      s.platformFees += platform;
      return;
    }
    case 'LOCK': {
      const a = asset();
      const amt = BigInt(p.amount);
      need(amt > 0n && !a.vaults.has(p.vault_id), 'bad lock');
      a.locked += amt;
      need(a.locked <= a.supply, 'locked > supply');
      a.vaults.set(p.vault_id, { amount: amt, unlockAt: Date.parse(p.unlock_at), claimed: false });
      return;
    }
    case 'UNLOCK': {
      const a = asset();
      const v = a.vaults.get(p.vault_id);
      need(!!v, 'unknown vault');
      need(!v!.claimed, 'vault redeemed twice');
      need(Date.parse(p.ts) >= v!.unlockAt, 'vault unlocked early');
      need(BigInt(p.amount) === v!.amount, 'unlock amount mismatch');
      v!.claimed = true;
      a.locked -= v!.amount;
      return;
    }
    case 'FEE_CLAIM': {
      const a = asset();
      a.feeClaimed += BigInt(p.amount);
      need(a.feeClaimed <= a.feeAccrued, 'fee claimed > accrued');
      return;
    }
    default:
      throw new ReplayError(`unknown event type ${ev.type}`);
  }
}

/** Canonical state commitment. Must match the server's DB-derived state. */
export function stateRoot(s: LogState): string {
  const assets = [...s.assets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, a]) => ({
      asset_id: id,
      supply: a.supply,
      reserve: a.reserve,
      locked: a.locked,
      fee_accrued: a.feeAccrued,
      fee_claimed: a.feeClaimed,
    }));
  return sha256Hex(canonical({ assets, platform_fees: s.platformFees }));
}

export function stateTotals(s: LogState) {
  let supply = 0n,
    reserve = 0n,
    locked = 0n,
    fees = 0n;
  for (const a of s.assets.values()) {
    supply += a.supply;
    reserve += a.reserve;
    locked += a.locked;
    fees += a.feeAccrued - a.feeClaimed;
  }
  return { assets: s.assets.size, supply, reserve, locked, unclaimed_creator_fees: fees, platform_fees: s.platformFees };
}
