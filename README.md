# nutpad — Cashu-native launchpad

Monorepo, two deployable services (plus Postgres) on Railway:

| Folder | What | Stack |
| --- | --- | --- |
| `nutpad_back/` | API + Cashu mint core + trade settlement + audit log + worker + independent verifier | Node 20+, TypeScript, Express, PostgreSQL |
| `nutpad_front/` | Arcade UI, local-first Cashu wallet, Nostr login | React 19, Vite, TypeScript |


## Run locally (no setup)

```bash
# terminal 1 — API on :8787 (embedded Postgres via PGlite, dev mint seed auto-generated)
cd nutpad_back && npm install && npm run dev

# terminal 2 — UI on :5173
cd nutpad_front && npm install && npm run dev
```

Open http://localhost:5173 → **Nostr Login** (NIP-07 extension, NIP-46 bunker/QR, or *Burner key* for testing) →
**Wallet → Get test sats** → **Create** a token → trade it on its page.

Tests and checks:

```bash
cd nutpad_back  && npm test                      # curve vectors, Merkle proofs, full e2e incl. double-spend race
cd nutpad_back  && npm run verify -- http://localhost:8787   # independent verifier (public API only)
cd nutpad_front && npx tsx scripts/smoke.ts      # browser-wallet logic against a running API
```

## Deploy on Railway (one GitHub repo, one Railway project)

1. Push this repo. In Railway create a project and add **PostgreSQL**.
2. Add service **nutpad-back** from the repo, *Root Directory* `nutpad_back`. Variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `MINT_SEED` = output of `openssl rand -hex 32` — **back it up**; it derives every keyset key
   - `FRONTEND_ORIGIN` = the front's public URL (after step 3)
   - `NOSTR_RELAYS` = `wss://relay.primal.net,wss://relay.snort.social,wss://offchain.pub,wss://nostr.bitcoiner.social,wss://nostr.oxtr.dev,wss://relay.damus.io,wss://nos.lol` (damus and nos.lol accept app-specific events but do not serve them back; keep relays that do, checked on 2026-11-10)
   - `DEMO_FAUCET=true` only for a demo (see limitations)
   - `NODE_ENV=production`
   Generate a public domain. With `NOSTR_RELAYS` set, the worker also publishes the audit log to those relays (see *Public log on Nostr*).
3. Add service **nutpad-front**, *Root Directory* `nutpad_front`. Variable `VITE_API_URL` = the back's public URL
   (**build-time**, set before deploying). Optional `VITE_MINT_PUBKEY` = the mint's Nostr key (`GET <back>/v1/info` → `pubkey`) so a first-time visitor can rebuild the token list from relays when the API is down; `VITE_CASHU_NPUB` = the Cashu account tagged in launch posts. Generate a domain, then put it into the back's `FRONTEND_ORIGIN`.
4. Check `GET <back>/health`, then run `npm run verify -- <back url>`.

## Lightning (testnet) — real deposits and withdrawals

The mint can run against a real Lightning wallet through **Nostr Wallet Connect** (`LN_BACKEND=nwc`, your own wallet, no node to run) or **LNbits** (`LN_BACKEND=lnbits`).
It is **testnet-only**: `LN_NETWORK` must be `testnet`, `signet` or `regtest`, invoices for any other
network are rejected, and the server refuses to start on mainnet unless `ALLOW_MAINNET=true`.

### Option 0 — upstream Cashu mint (simplest, no node, no keys)

nutpad keeps its treasury as a wallet at a public Cashu mint (the Mesh&Cash approach). For Mutinynet (signet):
```
LN_BACKEND=cashu
LN_NETWORK=signet
CASHU_UPSTREAM_URL=https://cashu.mutinynet.com
DEMO_FAUCET=false
```
Wallet → Deposit gives an `lntbs…` invoice; pay it from https://faucet.mutinynet.com/ (Lightning tab). The treasury wallet uses
deterministic secrets (seed derived from `MINT_SEED`), so proofs can be recovered with NUT-09 restore. Back up `MINT_SEED` and the database:
the treasury is the ecash held at the upstream mint, and the upstream operator can freeze or lose it.

### Option A — NWC

1. In a Lightning wallet on your test network (Mutinynet/signet, testnet…) create an NWC connection that allows `make_invoice`, `lookup_invoice`, `pay_invoice`, `get_balance` and copy the `nostr+walletconnect://…` link.
2. `nutpad_back/.env`:
   ```
   LN_BACKEND=nwc
   LN_NETWORK=signet          # Mutinynet is a signet; invoices start with lntbs
   NWC_URL=nostr+walletconnect://…
   DEMO_FAUCET=false
   ```
3. Restart the backend (a running `npm run dev` does not reload `.env`). Wallet → Deposit shows an invoice you can pay from https://faucet.mutinynet.com/ (Lightning tab).

The NWC link is a spending key for that wallet: use a dedicated wallet with a small balance, never a personal one.

### Option B — LNbits

1. Get an LNbits instance whose wallet is backed by a **testnet/signet** node (LND/CLN) and fund it with testnet coins.
2. In `nutpad_back/.env` (or Railway variables):
   ```
   LN_BACKEND=lnbits
   LN_NETWORK=testnet          # testnet -> lntb…, signet -> lntbs…, regtest -> lnbcrt…
   LNBITS_URL=https://your-lnbits.example
   LNBITS_ADMIN_KEY=<wallet admin key>
   DEMO_FAUCET=false           # the faucet makes unbacked sats; keep it off with a real backend
   ```
3. Wallet → **Deposit**: pay the invoice from any testnet wallet, ecash is minted when it settles. **Withdraw**: paste a testnet invoice.

How it stays safe: deposits are idempotent per quote; a withdrawal marks the proofs `PENDING` first, pays
outside the DB transaction, and signs the change only after the node reports success; a reconciler
settles or refunds stuck payments; one request at most can call `pay()`, and an invoice is never paid twice.
The audit page shows the **live treasury balance** and `BACKED / UNDERBACKED`; withdrawals are refused
while the treasury is below total obligations. This is an operator-reported live check, not a cryptographic proof.
No node was available in development: the LNbits adapter is tested against a mock of its REST API, and the full
flow against an in-process simulator (`LN_BACKEND=fake`). Run one real testnet round trip before relying on it.

## What is implemented

- Integer linear bonding curve (`C(0)=0`, `C(21M)=1,000,000`), 1% fee `ceil`, split 70/30 buyback-and-burn/creators (the 0.7% share buys the same token on the curve and burns it; the 1,000 sat launch fee is the dev fund), largest-remainder split among recipients; spec vector 11,890 / 119 / 83 / 36 is a test.
- Cashu BDHKE (secp256k1) mint with a keyset per asset (custom unit) + `sat` keyset; `/v1/keysets|keys|swap|checkstate|restore`.
- Atomic launch (1,000 sat fee + mandatory first buy ≤10% supply, trade #1), BUY/SELL, per-asset serialization (`SELECT … FOR UPDATE`), proof spending via a unique key (double-spend safe), `Idempotency-Key` on every mutation with stored results.
- Nostr login (NIP-98-style challenge, replay protected), signed immutable manifest (kind 30078), durable outbox with retry to relays.
- Creator fee split and idempotent fee claims; voluntary 7/30/90-day vault with beneficiary commitment, one-time recoverable claim.
- RFC 6962 Merkle log, signed checkpoints (Nostr events), inclusion/consistency proofs, state root, independent verifier CLI, "warning only" statuses, solvency page.
- Wallet: seed in the browser, crash-safe pending operations, send/receive bearer tokens, encrypted backup, restore from seed.
- **Buyback & burn:** the platform's 0.7% fee share buys the same token on the curve and burns it, in the same DB transaction as the trade (`BUYBACK` audit event; sats that do not buy a whole unit carry to the next trade). Burned supply is shown per token. The 1,000 sat launch fee is a separate dev fund (no withdrawal path yet).
- **Ecash over Nostr:** send sats or any token to an npub / name@domain. Proofs are locked to the receiver's wallet key (Cashu NUT-10/11 P2PK, BIP340 signatures, locktime + refund key) and published as a NIP-61 nutzap (kind 9321); the receiver publishes a kind 10019 event once and then claims automatically. Unclaimed transfers can be taken back after 7 days. The mint checks spending conditions in `spendInputs` (`nutpad_back/src/p2pk.ts`); single-pubkey `SIG_INPUTS` only, no multisig/HTLC.

## Public log on Nostr

The mint publishes its whole audit log to the relays in `NOSTR_RELAYS`, so state can be rebuilt and verified without our server:

- The log is cut into segments of 40 events. Segment *k* is a parameterized replaceable event (kind 30078, `d=nutpad-log-k`, `t=nutpad-log`) signed by the mint key. Content is one line per audit event, `seq|type|canonical payload`, i.e. exactly the Merkle leaf data. An open segment is re-published as it grows; closed ones once. Delivery uses the durable outbox, runs in the background worker and never blocks a trade (`nutpad_back/src/logpub.ts`).
- Anyone can fetch the segments, check the signatures, recompute the leaf hashes, the log root and the state root, and compare them with the signed checkpoints. `nutpad_front/src/lib/replay.ts` is the same deterministic replay the server and the verifier use.
- Token discovery: a manifest (creator-signed kind 30078, `t=nutpad-manifest`) belongs to a token when `sha256(content)` equals the `LAUNCH` event's `manifest_hash`. When the API is unreachable, Explore rebuilds the token list (supply, burned, volume, trades, name, ticker) from relays this way (`nutpad_front/src/lib/relaylog.ts`). Trading and token pages still need the API.
- Not decentralized: the mint is still a single custodian (spent-proof set, keys, reserves). The log makes its behaviour independently checkable and its history recoverable; it does not remove the trust in the operator.

## Known limits (read before real money)

- **Backing depends on your node.** Without `LN_BACKEND` the sats come from the demo faucet (unbacked, `UNVERIFIED`). With LNbits on testnet, deposits/withdrawals are real testnet payments. Mainnet is disabled.
- Nostr transfers only work between nutpad wallets on this mint (custom units); interoperability with other NIP-60/61 wallets is untested. Relay delivery of the log was checked against the public relays listed above, not against every relay's size limits.
- Custom units only work in this mint's wallet; tokens use `cashuA` (V3 JSON), not V4 CBOR. Seed derivation is HMAC based, not NUT-13 byte-compatible.
- Not built: Nostr incident reports/challenges, manual emergency pause, key rotation, KMS/HSM. Mint seed lives in an env var.
- Primal/NIP-46 is implemented through standard `bunker://` and `nostrconnect://`; not tested against a real Primal build.
- Trades authorize by proof possession (no Nostr signature); login is required for launch, vault and fee claims.
- The Postgres (`pg`) path is exercised only through PGlite locally (same SQL); verify on Railway after deploy.
- Merkle/state computations load the whole log (fine for MVP, needs incremental trees at scale).
- Needs an independent security review before any real use (spec phase 5).
