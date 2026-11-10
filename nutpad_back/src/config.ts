// load .env for local development (Railway injects real env vars)
try { (process as any).loadEnvFile?.('.env'); } catch { /* no .env */ }

const env = process.env;
const bool = (v: string | undefined, d = false) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));

export const config = {
  port: Number(env.PORT ?? 8787),
  production: env.NODE_ENV === 'production',
  databaseUrl: env.DATABASE_URL || '',
  pgliteDir: env.PGLITE_DIR === '' ? undefined : (env.PGLITE_DIR ?? '.data/pg'),
  /** hex, 32+ bytes. Mandatory in production. */
  mintSeedHex: env.MINT_SEED || '',
  frontendOrigins: (env.FRONTEND_ORIGIN ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  /** Public base URL of this API (used for NIP-98 `u` tag). Derived from the request if empty. */
  apiPublicUrl: (env.API_PUBLIC_URL ?? '').replace(/\/$/, ''),
  relays: (env.NOSTR_RELAYS ?? (env.NODE_ENV === 'production' ? '' : 'wss://relay.primal.net,wss://relay.snort.social,wss://offchain.pub,wss://nostr.bitcoiner.social,wss://nostr.oxtr.dev,wss://relay.damus.io,wss://nos.lol')).split(',').map((s) => s.trim()).filter(Boolean),
  /** Demo faucet: mints sat ecash out of thin air. NEVER enable with real funds. */
  demoFaucet: bool(env.DEMO_FAUCET, env.NODE_ENV !== 'production' && !['lnbits', 'nwc', 'cashu'].includes(env.LN_BACKEND ?? 'none')),
  /** Enables short (2 min) vault durations for testing. */
  demoMode: bool(env.DEMO_MODE, !(env.NODE_ENV === 'production')),
  demoVaultSeconds: Number(env.DEMO_VAULT_SECONDS ?? 120),
  ln: {
    backend: (env.LN_BACKEND ?? 'none') as 'none' | 'fake' | 'lnbits' | 'nwc' | 'cashu',
    upstreamUrl: (env.CASHU_UPSTREAM_URL ?? '').replace(/\/$/, ''),
    nwcUrl: env.NWC_URL ?? '',
    network: (env.LN_NETWORK ?? 'testnet') as 'regtest' | 'signet' | 'testnet' | 'mainnet',
    lnbitsUrl: (env.LNBITS_URL ?? '').replace(/\/$/, ''),
    lnbitsKey: env.LNBITS_ADMIN_KEY ?? '',
    allowMainnet: bool(env.ALLOW_MAINNET, false),
    maxSats: BigInt(env.LN_MAX_SATS ?? 100000),
  },
  runWorker: bool(env.RUN_WORKER, true),
  checkpointIntervalMs: Number(env.CHECKPOINT_INTERVAL_MS ?? 30_000),
};

if (config.production && !config.mintSeedHex) {
  throw new Error('MINT_SEED is required in production (openssl rand -hex 32)');
}
