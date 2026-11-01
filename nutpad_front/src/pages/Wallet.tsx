import { NostrIcon } from '../components/NostrIcon';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, imageUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, fmt } from '../lib/format';
import {
  checkDeposits, createDeposit, dropDeposit, exportBackup, faucet, importBackup, meltQuote, pruneSpent, settleDeposit, withdraw, type DepositQuote, type MeltQuote, receiveToken, refreshKeysets, restoreFromSeed,
  resumePending, runOp, satKeysetId, sendToken, useWallet, wipeWallet,
} from '../lib/wallet';
import { Field, Modal, useAction, useToast } from '../components/ui';
import { Nut, Prop } from '../components/Nut';
import { PixelIcon } from '../components/PixelIcon';
import type { AssetView } from './Explore';

type Tab = 'deposit' | 'withdraw' | 'send' | 'receive' | 'faucet';
const BACKUP_KEY = 'nutpad.backup.at';
const lastBackup = (): string | null => { try { return localStorage.getItem(BACKUP_KEY); } catch { return null; } };

export default function WalletPage({ onLogin }: { onLogin: () => void }) {
  const w = useWallet();
  const auth = useAuth();
  const toast = useToast();
  const { busy, run } = useAction();
  const [assets, setAssets] = useState<AssetView[]>([]);
  const [info, setInfo] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('deposit');
  const [depAmt, setDepAmt] = useState('5000');
  const [dep, setDep] = useState<(DepositQuote & { qr: string }) | null>(null);
  const [depState, setDepState] = useState('');
  const [wdInvoice, setWdInvoice] = useState('');
  const [wdQuote, setWdQuote] = useState<MeltQuote | null>(null);
  const [wdResult, setWdResult] = useState<any>(null);
  const [sendKs, setSendKs] = useState('');
  const [sendAmt, setSendAmt] = useState('');
  const [token, setToken] = useState<{ str: string; qr: string; label: string } | null>(null);
  const [recv, setRecv] = useState('');
  const [faucetAmt, setFaucetAmt] = useState('10000');
  const [fees, setFees] = useState<any[]>([]);
  const [backupOpen, setBackupOpen] = useState(false);
  const [pass, setPass] = useState('');
  const [seedIn, setSeedIn] = useState('');
  const [showSeed, setShowSeed] = useState(false);
  const [backedUp, setBackedUp] = useState<string | null>(lastBackup());

  useEffect(() => {
    refreshKeysets().catch(() => {});
    api('GET', '/assets?sort=new').then((r) => setAssets(r.assets)).catch(() => {});
    api('GET', '/v1/info').then(setInfo).catch(() => {});
  }, []);
  useEffect(() => {
    if (!dep) return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const r = await settleDeposit(dep);
        if (!alive) return;
        if (r === 'DONE') { setDepState('DONE'); setDep(null); toast(`Deposit received: +${fmt(dep.amount)} sats`, 'ok'); }
        else if (r === 'EXPIRED') { setDepState('EXPIRED'); setDep(null); }
        else setDepState(r);
      } catch { /* keep polling */ }
    }, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [dep]); // eslint-disable-line react-hooks/exhaustive-deps
  const ln = info?.ln;
  useEffect(() => { void checkDeposits(); }, []);
  const loadFees = () => (auth.pubkey ? api('GET', '/fees/me').then((r) => setFees(r.balances)).catch(() => {}) : undefined);
  useEffect(() => { void loadFees(); }, [auth.pubkey]); // eslint-disable-line react-hooks/exhaustive-deps

  const sat = w.keysets.find((k) => k.unit === 'sat');
  const satBal = sat ? w.balance(sat.id) : 0;
  const holdings = useMemo(
    () =>
      w.keysets
        .filter((k) => k.asset_id)
        .map((k) => ({ k, bal: w.balance(k.id), asset: assets.find((a) => a.asset_id === k.asset_id) }))
        .filter((h) => h.bal > 0),
    [w, assets],
  );
  const sendable = [...(sat ? [{ id: sat.id, label: 'sats', bal: satBal }] : []), ...holdings.map((h) => ({ id: h.k.id, label: `$${h.asset?.ticker ?? h.k.unit}`, bal: h.bal }))];
  const selected = sendable.find((s) => s.id === sendKs);
  const needsBackup = (satBal > 0 || holdings.length > 0) && !backedUp;

  const doSend = () => run(async () => {
    const str = await sendToken(sendKs, Number(sendAmt));
    const qr = await QRCode.toDataURL(str.length < 1800 ? str : 'token too long for QR', { margin: 1, width: 220 }).catch(() => '');
    setToken({ str, qr, label: `${fmt(sendAmt)} ${selected?.label ?? ''}` });
    setSendAmt('');
  });

  const goto = (t: Tab) => { setTab(t); setTimeout(() => document.getElementById('wallet-actions')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); };
  const openSend = (ksId: string) => { setSendKs(ksId); setTab('send'); document.getElementById('wallet-actions')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };

  return (
    <div style={{ marginTop: 20 }} className="col">
      {/* ───── balance hero ───── */}
      <div className="px wallet-hero">
        <div className="wallet-hero-main">
          <div className="wallet-nut"><Nut k="cashu" scale={4} /><Prop name="coin" scale={3} className="wallet-coin" /></div>
          <div>
            <div className="label">Total balance</div>
            <div className="wallet-bal"><PixelIcon name="coin" size={30} /> {fmt(satBal)} <span>sats</span></div>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <span className="tag cyan">{w.proofs.length} proofs</span>
              <span className="tag">{holdings.length} token{holdings.length === 1 ? '' : 's'}</span>
              {w.pending.length > 0 && <span className="tag red">{w.pending.length} pending</span>}
            </div>
          </div>
        </div>
        <div className="wallet-quick">
          <button className="green" onClick={() => goto('deposit')}><PixelIcon name="deposit" size={16} />Deposit</button>
          <button className="red" onClick={() => goto('withdraw')}><PixelIcon name="withdraw" size={16} />Withdraw</button>
          <button onClick={() => { if (!sendKs && sat) setSendKs(sat.id); goto('send'); }}><PixelIcon name="send" size={16} />Send</button>
          <button className="cyan" onClick={() => goto('receive')}><PixelIcon name="receive" size={16} />Receive</button>
          {info?.demo_faucet && <button className="ghost" onClick={() => goto('faucet')}>+ Test sats</button>}
        </div>
      </div>

      {needsBackup && (
        <div className="wallet-warn">
          <b>Not backed up.</b> Your funds exist only in this browser. Clearing site data loses them.
          <button className="sm" onClick={() => setBackupOpen(true)}>Back up now</button>
        </div>
      )}

      <div className="grid two">
        <div className="col">
          {/* ───── holdings ───── */}
          <div className="px">
            <h3>Your tokens</h3>
            {holdings.length === 0 ? (
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <Nut k="pea" scale={3} />
                <div className="speech-lite" style={{ marginBottom: 20 }}>No tokens yet. Pick one on Explore and buy some!</div>
              </div>
            ) : (
              <div className="holdings">
                {holdings.map(({ k, bal, asset }) => (
                  <div key={k.id} className="holding">
                    {asset ? <img src={imageUrl(asset.asset_id)} alt="" className="holding-img" /> : <div className="holding-img" />}
                    <div className="grow">
                      <b>{asset?.name ?? k.unit}</b> <span className="tag yellow">${asset?.ticker ?? '?'}</span>
                      <div className="dim">{fmt(bal)} units</div>
                    </div>
                    {asset && <Link to={`/token/${asset.asset_id}`} className="btn sm">Trade</Link>}
                    <button className="ghost sm" onClick={() => openSend(k.id)}>Send</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ───── actions ───── */}
          <div className="px hot" id="wallet-actions">
            <div className="tabs wallet-tabs">
              <button className={tab === 'deposit' ? 'on buy' : ''} onClick={() => setTab('deposit')}>Deposit</button>
              <button className={tab === 'withdraw' ? 'on buy' : ''} onClick={() => setTab('withdraw')}>Withdraw</button>
              <button className={tab === 'send' ? 'on buy' : ''} onClick={() => setTab('send')}>Send</button>
              <button className={tab === 'receive' ? 'on buy' : ''} onClick={() => setTab('receive')}>Receive</button>
              {info?.demo_faucet && <button className={tab === 'faucet' ? 'on buy' : ''} onClick={() => setTab('faucet')}>Faucet</button>}
            </div>

            {tab === 'deposit' && !ln?.enabled && (
              <div className="login-hint warn">Lightning is not configured on this mint yet. Set <span className="mono">LN_BACKEND=nwc</span> and <span className="mono">NWC_URL</span> (a Nostr Wallet Connect link from your testnet Lightning wallet) in <span className="mono">nutpad_back/.env</span> and restart the backend. See README, "Lightning (testnet)".</div>
            )}

            {tab === 'deposit' && ln?.enabled && (
              <div className="col">
                <div className="login-hint warn">Lightning <b>{String(ln.network).toUpperCase()}</b> — use testnet coins only. Max {fmt(ln.max_sats)} sats per deposit.</div>
                {!dep ? (<>
                  <div className="pills">
                    {[1000, 5000, 20000].map((n) => <button key={n} className={`pill ${depAmt === String(n) ? 'on' : ''}`} onClick={() => setDepAmt(String(n))}>{fmt(n)}</button>)}
                  </div>
                  <Field label="Amount (sats)"><input inputMode="numeric" value={depAmt} onChange={(e) => setDepAmt(e.target.value.replace(/\D/g, ''))} /></Field>
                  <button className="green" disabled={busy || !depAmt || Number(depAmt) < 1} onClick={() => run(async () => {
                    const d = await createDeposit(Number(depAmt));
                    setDepState('UNPAID');
                    setDep({ ...d, qr: await QRCode.toDataURL('lightning:' + d.request.toUpperCase(), { margin: 1, width: 260, errorCorrectionLevel: 'L' }) });
                  })}>{busy ? 'Creating…' : 'Create invoice'}</button>
                </>) : (
                  <div className="px inner col" style={{ alignItems: 'center' }}>
                    <b>Pay {fmt(dep.amount)} sats</b>
                    <div className="qr"><img src={dep.qr} alt="Lightning invoice" /></div>
                    <textarea readOnly className="mono" value={dep.request} onFocus={(e) => e.currentTarget.select()} />
                    <div className="row">
                      <button className="sm" onClick={() => navigator.clipboard.writeText(dep.request).then(() => toast('Invoice copied', 'ok'))}>Copy invoice</button>
                      <a className="btn sm" href={`lightning:${dep.request}`}>Open wallet</a>
                      <button className="ghost sm" onClick={() => { dropDeposit(dep.quote); setDep(null); }}>Cancel</button>
                    </div>
                    <div className="login-status"><i className="dot" /> {depState === 'PAID' ? 'Paid — minting your ecash…' : 'Waiting for payment…'}</div>
                  </div>
                )}
                {w.deposits.length > 0 && !dep && (
                  <div className="dim" style={{ fontSize: 13 }}>
                    {w.deposits.length} earlier invoice{w.deposits.length > 1 ? 's' : ''} waiting:{' '}
                    {w.deposits.map((d) => <button key={d.quote} className="ghost sm" style={{ marginRight: 6 }} onClick={async () => setDep({ ...d, qr: await QRCode.toDataURL('lightning:' + d.request.toUpperCase(), { margin: 1, width: 260, errorCorrectionLevel: 'L' }) })}>{fmt(d.amount)} sats</button>)}
                  </div>
                )}
                <div className="dim" style={{ fontSize: 13 }}>If you close this page after paying, the ecash is minted automatically the next time the wallet opens.</div>
              </div>
            )}

            {tab === 'withdraw' && !ln?.enabled && (
              <div className="login-hint warn">Lightning is not configured on this mint yet. Set <span className="mono">LN_BACKEND=nwc</span> and <span className="mono">NWC_URL</span> (a Nostr Wallet Connect link from your testnet Lightning wallet) in <span className="mono">nutpad_back/.env</span> and restart the backend. See README, "Lightning (testnet)".</div>
            )}

            {tab === 'withdraw' && ln?.enabled && (
              <div className="col">
                <div className="login-hint warn">Pays a Lightning invoice on <b>{String(ln.network).toUpperCase()}</b> from your sats. A fee reserve (max of 2 sats or 1%) is held and is the flat fee.</div>
                <Field label="Lightning invoice (bolt11)"><textarea className="mono" placeholder="lntb… / lntbs… / lnbcrt…" value={wdInvoice} onChange={(e) => { setWdInvoice(e.target.value); setWdQuote(null); setWdResult(null); }} /></Field>
                {!wdQuote ? (
                  <button className="cyan" disabled={busy || !wdInvoice.trim()} onClick={() => run(async () => { setWdQuote(await meltQuote(wdInvoice)); })}>{busy ? 'Checking…' : 'Get quote'}</button>
                ) : (
                  <div className="px inner col">
                    <div className="stat"><span className="dim">Invoice amount</span><b>{fmt(wdQuote.amount)} sats</b></div>
                    <div className="stat"><span className="dim">Fee reserve</span><b>{fmt(wdQuote.fee_reserve)} sats</b></div>
                    <div className="stat"><span className="dim">Total from wallet</span><b className="yellow">{fmt(BigInt(wdQuote.amount) + BigInt(wdQuote.fee_reserve))} sats</b></div>
                    {satBal < Number(wdQuote.amount) + Number(wdQuote.fee_reserve) && <div className="red">Not enough sats.</div>}
                    <button className="red" disabled={busy || satBal < Number(wdQuote.amount) + Number(wdQuote.fee_reserve)} onClick={() => run(async () => {
                      const r = await withdraw(wdQuote);
                      setWdResult(r.response);
                      setWdQuote(null);
                      setWdInvoice('');
                      toast('Invoice paid', 'ok');
                    })}>{busy ? 'Paying…' : 'Pay invoice'}</button>
                  </div>
                )}
                {wdResult && <div className="login-hint">Paid. Preimage: <span className="mono">{wdResult.payment_preimage ?? 'n/a'}</span></div>}
                {w.pending.some((p) => p.kind === 'withdraw') && <div className="login-hint warn">A payment is still in flight. Your tokens stay locked until the node confirms or fails it; this wallet checks automatically.</div>}
              </div>
            )}

            {tab === 'send' && (
              <div className="col">
                <div className="row">
                  <div className="grow" style={{ minWidth: 150 }}>
                    <Field label="Asset">
                      <select value={sendKs} onChange={(e) => setSendKs(e.target.value)}>
                        <option value="">choose…</option>
                        {sendable.map((s) => <option key={s.id} value={s.id}>{s.label} — {fmt(s.bal)}</option>)}
                      </select>
                    </Field>
                  </div>
                  <div className="grow" style={{ minWidth: 150 }}>
                    <Field label="Amount"><input inputMode="numeric" placeholder="0" value={sendAmt} onChange={(e) => setSendAmt(e.target.value.replace(/\D/g, ''))} /></Field>
                  </div>
                </div>
                {selected && <div className="row"><button className="ghost sm" onClick={() => setSendAmt(String(selected.bal))}>Max {fmt(selected.bal)}</button></div>}
                <button disabled={busy || !sendKs || !sendAmt || Number(sendAmt) > (selected?.bal ?? 0)} onClick={doSend}>{busy ? 'Working…' : 'Create bearer token'}</button>
                {token && (
                  <div className="px inner col">
                    <b className="green">Token ready — {token.label}</b>
                    {token.qr && <div className="qr"><img src={token.qr} alt="token QR" /></div>}
                    <textarea readOnly className="mono" value={token.str} onFocus={(e) => e.currentTarget.select()} />
                    <div className="row">
                      <button className="sm" onClick={() => navigator.clipboard.writeText(token.str).then(() => toast('Copied', 'ok'))}>Copy</button>
                      <button className="ghost sm" onClick={() => setToken(null)}>Hide</button>
                    </div>
                    <div className="login-hint warn">Whoever has this token can spend it. The receiver should redeem it right away so you cannot double-spend it. Custom units may not work in other Cashu wallets.</div>
                  </div>
                )}
              </div>
            )}

            {tab === 'receive' && (
              <div className="col">
                <div className="dim" style={{ fontSize: 13 }}>Receive a bearer token someone sent you. To receive Lightning sats, use the Deposit tab.</div>
                <Field label="Paste a cashuA token"><textarea className="mono" placeholder="cashuA…" value={recv} onChange={(e) => setRecv(e.target.value)} /></Field>
                <button className="cyan" disabled={busy || !recv.trim()} onClick={() => run(async () => {
                  const r = await receiveToken(recv);
                  setRecv('');
                  toast(`Received ${fmt(r.amount)} ${r.unit} — swapped to fresh proofs`, 'ok');
                })}>{busy ? 'Redeeming…' : 'Redeem token'}</button>
                <div className="dim" style={{ fontSize: 13 }}>Redeeming swaps the token for new proofs only you hold, which protects you from the sender spending it again.</div>
              </div>
            )}

            {tab === 'faucet' && info?.demo_faucet && (
              <div className="col">
                <div className="login-hint warn">Demo faucet: these sats are not backed by real bitcoin.</div>
                <div className="pills">
                  {[1000, 10000, 100000].map((n) => <button key={n} className={`pill ${faucetAmt === String(n) ? 'on' : ''}`} onClick={() => setFaucetAmt(String(n))}>{fmt(n)}</button>)}
                </div>
                <Field label="Amount (max 100,000)"><input inputMode="numeric" value={faucetAmt} onChange={(e) => setFaucetAmt(e.target.value.replace(/\D/g, ''))} /></Field>
                <button className="green" disabled={busy || !faucetAmt || Number(faucetAmt) > 100000} onClick={() => run(async () => { await faucet(Number(faucetAmt)); }, `+${fmt(faucetAmt)} test sats`)}>{busy ? 'Minting…' : 'Get test sats'}</button>
              </div>
            )}
          </div>
        </div>

        <div className="col">
          {/* ───── creator fees ───── */}
          <div className="px">
            <h3>Creator fees</h3>
            {!auth.pubkey ? (
              <div className="col"><span className="dim">Log in to see fees accrued for your Nostr key.</span><button className="sm" onClick={onLogin}><NostrIcon size={18} />Nostr Login</button></div>
            ) : fees.length === 0 ? <div className="dim">No fees accrued yet.</div> : fees.map((f) => (
              <div key={f.asset_id} className="stat">
                <span>${f.ticker}: <b className="yellow">{fmt(f.claimable_sats)}</b> sats</span>
                <button className="sm" disabled={busy || Number(f.claimable_sats) === 0} onClick={() => run(async () => {
                  await runOp({ kind: 'fee-claim', path: '/fees/claim', inputs: [], inputsField: null, extra: { asset_id: f.asset_id }, groups: [{ name: 'sat', keysetId: await satKeysetId(), field: 'signatures', total: Number(f.claimable_sats) }] });
                  await loadFees();
                }, 'Fees claimed')}>Claim</button>
              </div>
            ))}
          </div>

          {w.pending.length > 0 && (
            <div className="px pinkb">
              <h3>Interrupted operations ({w.pending.length})</h3>
              {w.pending.map((p) => <div key={p.id} className="stat"><span>{p.kind}</span><span className="dim">{ago(new Date(p.createdAt).toISOString())}</span></div>)}
              <button disabled={busy} style={{ marginTop: 8 }} onClick={() => run(async () => { await resumePending(); }, 'Retried with the same idempotency key')}>Retry now</button>
            </div>
          )}

          {/* ───── backup ───── */}
          <div className="px">
            <h3>Backup &amp; restore</h3>
            <div className="row" style={{ marginBottom: 10 }}>
              <span className={`tag ${backedUp ? 'green' : 'red'}`}>{backedUp ? `Backed up ${ago(backedUp)}` : 'Never backed up'}</span>
            </div>
            <div className="col">
              <button onClick={() => setBackupOpen(true)}>Encrypted backup / import</button>
              <button className="ghost" onClick={() => setShowSeed(!showSeed)}>{showSeed ? 'Hide' : 'Reveal'} wallet seed</button>
              {showSeed && <div className="seedbox mono">{w.seed}</div>}
              <button className="ghost" disabled={busy} onClick={() => run(async () => { const n = await pruneSpent(); toast(`Removed ${n} spent proofs`); })}>Check proofs with mint</button>
              <hr style={{ margin: '4px 0' }} />
              <Field label="Restore from seed"><input className="mono" placeholder="64 hex characters" value={seedIn} onChange={(e) => setSeedIn(e.target.value.trim())} /></Field>
              <button className="cyan" disabled={busy || seedIn.length !== 64} onClick={() => run(async () => {
                const r = await restoreFromSeed(seedIn);
                setSeedIn('');
                toast(`Restored ${r.recovered} proofs`, 'ok');
              })}>Restore</button>
              <div className="dim" style={{ fontSize: 13 }}>Seed restore recovers proofs the mint signed for your seed. Tokens imported from elsewhere live only in the encrypted backup.</div>
            </div>
          </div>

          <div className="px">
            <h3 style={{ color: 'var(--bad)' }}>Danger zone</h3>
            <button className="red sm" onClick={() => { if (confirm('Wipe the local wallet? Make sure you have a backup!')) wipeWallet(); }}>Wipe local wallet</button>
          </div>
        </div>
      </div>

      {backupOpen && (
        <Modal title="Encrypted backup" onClose={() => setBackupOpen(false)}>
          <div className="col">
            <Field label="Passphrase (at least 8 characters)"><input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
            <button disabled={busy || pass.length < 8} onClick={() => run(async () => {
              const blob = new Blob([await exportBackup(pass)], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `nutpad-wallet-${Date.now()}.json`;
              a.click();
              const now = new Date().toISOString();
              try { localStorage.setItem(BACKUP_KEY, now); } catch { /* ignore */ }
              setBackedUp(now);
            }, 'Backup downloaded')}>Download backup</button>
            <hr />
            <Field label="Import a backup file"><input type="file" accept="application/json" onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void run(async () => { await importBackup(await f.text(), pass); setBackupOpen(false); }, 'Wallet imported');
            }} /></Field>
            <div className="dim" style={{ fontSize: 13 }}>AES-256-GCM, key derived with PBKDF2 (250k iterations). Enter the passphrase before choosing the file.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}
