// Mint core: keysets, proof verification/spending, blind signing.
// Everything here runs inside a caller-supplied DB transaction, so a blind
// signature is only ever returned to a client after its liability is committed.
import { randomBytes } from 'node:crypto';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { config } from './config.js';
import { big, type Conn, type Db } from './db.js';
import { AMOUNTS, isValidPoint, keysetFor, proofY, signBlinded, verifyProof, type Keyset } from './cashu.js';
import { ApiError, canonical, isHex, sha256Hex } from './util.js';

export const SAT_SCOPE = 'sat';
export const MAX_IO = 64;

export interface Proof {
  id: string;
  amount: number;
  secret: string;
  C: string;
}
export interface BlindedMessage {
  id: string;
  amount: number;
  B_: string;
}
export interface BlindSignature {
  id: string;
  amount: number;
  C_: string;
}

export interface KeysetInfo {
  id: string;
  scope: string;
  unit: string;
  assetId: string | null;
  active: boolean;
}

export class Mint {
  seed!: Uint8Array;
  nostrSk!: Uint8Array;
  nostrPk!: string;
  private keysets = new Map<string, KeysetInfo>();
  private keysetKeys = new Map<string, Keyset>();
  private assetKeysets = new Map<string, string>();
  satKeysetId!: string;
  ln: import('./ln.js').LnBackend | null = null;

  constructor(public db: Db) {}

  async init() {
    let hex = config.mintSeedHex;
    if (!hex) {
      const r = await this.db.query<{ value: string }>(`SELECT value FROM meta WHERE key='dev_mint_seed'`);
      if (r.rows[0]) hex = r.rows[0].value;
      else {
        hex = bytesToHex(randomBytes(32));
        await this.db.query(`INSERT INTO meta(key,value) VALUES('dev_mint_seed',$1)`, [hex]);
        console.warn('[mint] MINT_SEED not set: generated a dev seed stored in the database (dev only)');
      }
    }
    if (!isHex(hex) || hex.length < 64) throw new Error('MINT_SEED must be >= 32 bytes of hex');
    this.seed = hexToBytes(hex);
    this.nostrSk = hmac(sha256, this.seed, utf8ToBytes('nutpad/nostr-signing'));
    this.nostrPk = bytesToHex(schnorr.getPublicKey(this.nostrSk));

    const sat = keysetFor(this.seed, SAT_SCOPE, 'sat');
    this.satKeysetId = sat.id;
    await this.db.query(
      `INSERT INTO keysets(keyset_id,scope,asset_id,unit) VALUES($1,$2,NULL,'sat') ON CONFLICT DO NOTHING`,
      [sat.id, SAT_SCOPE],
    );
    const rows = await this.db.query<any>(`SELECT keyset_id,scope,asset_id,unit,active FROM keysets`);
    for (const k of rows.rows)
      this.commitKeyset({ id: k.keyset_id, scope: k.scope, unit: k.unit, assetId: k.asset_id, active: k.active });
  }

  /** Register a keyset for a new asset inside the launch transaction. */
  async registerAssetKeyset(c: Conn, assetId: string, unit: string): Promise<KeysetInfo> {
    const ks = keysetFor(this.seed, assetId, unit);
    await c.query(`INSERT INTO keysets(keyset_id,scope,asset_id,unit) VALUES($1,$2,$3,$4)`, [
      ks.id,
      assetId,
      assetId,
      unit,
    ]);
    const info = { id: ks.id, scope: assetId, unit, assetId, active: true };
    return info;
  }

  commitKeyset(info: KeysetInfo) {
    this.keysets.set(info.id, info);
    if (info.assetId) this.assetKeysets.set(info.assetId, info.id);
  }

  dropKeyset(info: KeysetInfo) {
    this.keysets.delete(info.id);
    this.keysetKeys.delete(info.id);
    if (info.assetId) this.assetKeysets.delete(info.assetId);
  }

  assetKeysetId(assetId: string): string | undefined {
    return this.assetKeysets.get(assetId);
  }

  keysetInfo(id: string): KeysetInfo | undefined {
    return this.keysets.get(id);
  }

  allKeysets(): KeysetInfo[] {
    return [...this.keysets.values()];
  }

  keysFor(id: string): Keyset | undefined {
    const info = this.keysets.get(id);
    if (!info) return undefined;
    let k = this.keysetKeys.get(id);
    if (!k) {
      k = keysetFor(this.seed, info.scope, info.unit);
      this.keysetKeys.set(id, k);
    }
    return k;
  }

  /**
   * Verify and atomically mark inputs as spent. The unique key on `proofs.y`
   * is the single source of truth: two concurrent spends of one proof cannot
   * both commit. Returns the total amount per keyset.
   */
  async spendInputs(c: Conn, inputs: Proof[], opRef: string, state: 'SPENT' | 'PENDING' = 'SPENT'): Promise<Map<string, bigint>> {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_IO)
      throw new ApiError(400, 'BAD_INPUTS', `1..${MAX_IO} inputs required`);
    const totals = new Map<string, bigint>();
    for (const p of inputs) {
      if (!p || typeof p.id !== 'string' || typeof p.secret !== 'string' || typeof p.C !== 'string')
        throw new ApiError(400, 'BAD_PROOF');
      if (p.secret.length > 256) throw new ApiError(400, 'BAD_PROOF');
      const ks = this.keysets.get(p.id);
      if (!ks) throw new ApiError(400, 'UNKNOWN_KEYSET', `unknown keyset ${p.id}`);
      if (!AMOUNTS.includes(p.amount)) throw new ApiError(400, 'BAD_AMOUNT');
      if (!verifyProof(this.seed, ks.scope, p.amount, p.secret, p.C))
        throw new ApiError(400, 'INVALID_PROOF', 'proof signature invalid');
      const y = proofY(p.secret);
      const ins = await c.query(
        `INSERT INTO proofs(y,keyset_id,amount,op_ref,state) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING y`,
        [y, p.id, p.amount, opRef, state],
      );
      if (ins.rows.length === 0) throw new ApiError(400, 'TOKEN_ALREADY_SPENT', 'proof already spent');
      totals.set(p.id, (totals.get(p.id) ?? 0n) + BigInt(p.amount));
    }
    return totals;
  }

  /** Validate outputs structurally (before any state changes). */
  checkOutputs(outputs: BlindedMessage[], allowedKeyset: (k: KeysetInfo) => boolean): bigint {
    if (!Array.isArray(outputs) || outputs.length > MAX_IO) throw new ApiError(400, 'BAD_OUTPUTS');
    const seen = new Set<string>();
    let sum = 0n;
    for (const o of outputs) {
      const ks = o && this.keysets.get(o.id);
      if (!ks || !ks.active) throw new ApiError(400, 'UNKNOWN_KEYSET', 'output keyset unknown/inactive');
      if (!allowedKeyset(ks)) throw new ApiError(400, 'WRONG_UNIT', 'output keyset not allowed here');
      if (!AMOUNTS.includes(o.amount)) throw new ApiError(400, 'BAD_AMOUNT');
      if (typeof o.B_ !== 'string' || !isValidPoint(o.B_)) throw new ApiError(400, 'BAD_BLINDED_MESSAGE');
      if (seen.has(o.B_)) throw new ApiError(400, 'DUPLICATE_OUTPUT');
      seen.add(o.B_);
      sum += BigInt(o.amount);
    }
    return sum;
  }

  /** Sign outputs and record the issuance liability. Fails if any B_ was signed before. */
  async signOutputs(c: Conn, outputs: BlindedMessage[], operationId: string): Promise<BlindSignature[]> {
    const sigs: BlindSignature[] = [];
    for (const o of outputs) {
      const ks = this.keysets.get(o.id)!;
      const C_ = signBlinded(this.seed, ks.scope, o.amount, o.B_);
      const ins = await c.query(
        `INSERT INTO outgoing_signatures(blinded_message,keyset_id,amount,signature,operation_id)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING blinded_message`,
        [o.B_, o.id, o.amount, C_, operationId],
      );
      if (ins.rows.length === 0) throw new ApiError(400, 'OUTPUT_ALREADY_SIGNED', 'blinded message already signed');
      sigs.push({ id: o.id, amount: o.amount, C_ });
    }
    return sigs;
  }

  /** Mint-key Schnorr signature over a canonical receipt object. */
  signReceipt(receipt: unknown): { receipt_hash: string; sig: string } {
    const h = sha256Hex(canonical(receipt));
    return { receipt_hash: h, sig: bytesToHex(schnorr.sign(hexToBytes(h), this.nostrSk)) };
  }
}

export const sumAmounts = (xs: { amount: number }[]) => xs.reduce((a, x) => a + BigInt(x.amount), 0n);

export async function unspentByKeyset(c: Conn): Promise<Map<string, bigint>> {
  const issued = await c.query<any>(`SELECT keyset_id, COALESCE(SUM(amount),0) AS s FROM outgoing_signatures GROUP BY keyset_id`);
  const spent = await c.query<any>(`SELECT keyset_id, COALESCE(SUM(amount),0) AS s FROM proofs GROUP BY keyset_id`);
  const m = new Map<string, bigint>();
  for (const r of issued.rows) m.set(r.keyset_id, big(r.s));
  for (const r of spent.rows) m.set(r.keyset_id, (m.get(r.keyset_id) ?? 0n) - big(r.s));
  return m;
}
