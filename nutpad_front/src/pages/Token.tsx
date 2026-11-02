import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, imageUrl } from '../lib/api';
import { ago, fmt, fmtPrice, shortKey } from '../lib/format';
import { nip19 } from 'nostr-tools';
import { satKeysetId, trade, useWallet } from '../lib/wallet';
import { Field, Stat, useAction, useCelebrate, useToast } from '../components/ui';
import { CandleChart, CurveChart, FRAMES, PriceChart, type Frame } from '../components/Charts';
import type { AssetView } from './Explore';
import { Nut, NutImg } from '../components/Nut';
import { NostrIcon } from '../components/NostrIcon';
import { PixelIcon } from '../components/PixelIcon';

type Full = AssetView & { fee_split: { pubkey: string; bps: number }[]; manifest_json: string; manifest_event: any; free_supply: string };

function TradePanel({ asset, onDone }: { asset: AssetView; onDone: () => void }) {
  const w = useWallet();
  const celebrate = useCelebrate();
  const { busy, run } = useAction();
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<any>(null);
  const [qerr, setQerr] = useState('');
  const [satKs, setSatKs] = useState('');
  useEffect(() => { satKeysetId().then(setSatKs).catch(() => {}); }, []);

  const held = asset.keyset_id ? w.balance(asset.keyset_id) : 0;
  const sats = satKs ? w.balance(satKs) : 0;

  useEffect(() => {
    setQuote(null);
    setQerr('');
    if (!/^\d+$/.test(amount) || amount === '0') return;
    const t = setTimeout(() => {
      api('POST', '/trades/quote', { asset_id: asset.asset_id, side, ...(side === 'BUY' ? { sats: amount } : { units: amount }) })
        .then(setQuote)
        .catch((e) => setQerr(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [amount, side, asset.asset_id, asset.supply]);

  const submit = () =>
    run(async () => {
      if (!asset.keyset_id) throw new Error('Asset keyset missing');
      const r = await trade(asset.asset_id, asset.keyset_id, side, side === 'BUY' ? { sats: BigInt(amount) } : { units: BigInt(amount) });
      const t = r.response.trade;
      celebrate(t.side === 'BUY'
        ? { stamp: 'BOUGHT!', nut: 'walt', tone: 'buy', text: `Walt grabbed ${fmt(t.delta_units)} $${asset.ticker} for ${fmt(t.gross_sats)} sats (+${fmt(t.fee_sats)} fee). Trade #${t.seq}.` }
        : { stamp: 'SOLD!', nut: 'pista', tone: 'sell', text: `Pista sold ${fmt(t.delta_units)} $${asset.ticker} for ${fmt(t.gross_sats)} sats (-${fmt(t.fee_sats)} fee). Trade #${t.seq}.` });
      setAmount('');
      onDone();
    });

  const insufficient = side === 'BUY' ? quote && Number(quote.total) > sats : /^\d+$/.test(amount) && Number(amount) > held;
  const avg = quote && Number(quote.delta || amount) > 0 ? (Number(quote.gross) / Number(side === 'BUY' ? quote.delta : amount)) : null;

  return (
    <div className="px hot trade">
      <div className="trade-head">
        <div>
          <h2 style={{ margin: 0 }}>Trade <span className="yellow">${asset.ticker}</span></h2>
          <div className="dim" style={{ fontSize: 13 }}>Price now <b className="green">{fmtPrice(asset.price_nano)}</b> sat</div>
        </div>
        <Nut k={side === 'BUY' ? 'walt' : 'pista'} scale={2} talking={busy} />
      </div>

      <div className="tabs">
        <button className={`buy ${side === 'BUY' ? 'on' : ''}`} onClick={() => { setSide('BUY'); setAmount(''); }}>Buy</button>
        <button className={`sell ${side === 'SELL' ? 'on' : ''}`} onClick={() => { setSide('SELL'); setAmount(''); }}>Sell</button>
      </div>

      <Field label={side === 'BUY' ? 'You spend (sats, incl. fee)' : `You sell (${asset.ticker})`}>
        <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} placeholder={side === 'BUY' ? '1000' : '100000'} />
      </Field>
      <div className="chips">
        {side === 'BUY'
          ? [100, 1000, 10000].map((n) => <button key={n} className="pill" onClick={() => setAmount(String(n))}>{fmt(n)}</button>)
          : [25, 50].map((p) => <button key={p} className="pill" onClick={() => setAmount(String(Math.floor((held * p) / 100)))}>{p}%</button>)}
        <button className="pill" onClick={() => setAmount(String(side === 'BUY' ? sats : held))}>Max</button>
      </div>

      <div className={`receipt ${quote ? 'on' : ''}`}>
        {quote && side === 'BUY' && (<>
          <div className="receipt-main"><span className="dim">You get</span><b className="green">{fmt(quote.delta)} {asset.ticker}</b></div>
          <Stat k="Curve cost" v={`${fmt(quote.gross)} sats`} />
          <Stat k="Fee 1%" v={`${fmt(quote.fee)} sats`} />
          <Stat k="Total" v={<b>{fmt(quote.total)} sats</b>} />
          {avg !== null && <Stat k="Avg price" v={`${avg.toFixed(5)} sat`} />}
        </>)}
        {quote && side === 'SELL' && (<>
          <div className="receipt-main"><span className="dim">You get</span><b className="green">{fmt(quote.payout)} sats</b></div>
          <Stat k="Curve value" v={`${fmt(quote.gross)} sats`} />
          <Stat k="Fee 1%" v={`${fmt(quote.fee)} sats`} />
          {avg !== null && <Stat k="Avg price" v={`${avg.toFixed(5)} sat`} />}
        </>)}
        {!quote && !qerr && <div className="dim" style={{ textAlign: 'center' }}>Enter an amount to see the quote</div>}
        {qerr && <div className="red">{qerr}</div>}
      </div>

      <Stat k="Wallet" v={side === 'BUY' ? `${fmt(sats)} sats` : `${fmt(held)} ${asset.ticker}`} />
      {insufficient && <div className="red" style={{ fontSize: 14 }}>Not enough balance. <Link to="/wallet">Open wallet</Link></div>}
      <button className={side === 'BUY' ? 'green' : 'red'} style={{ width: '100%', marginTop: 12, padding: '0.85rem' }} disabled={busy || !quote || !!insufficient} onClick={submit}>
        {busy ? 'Working…' : side === 'BUY' ? `Buy ${asset.ticker}` : `Sell ${asset.ticker}`}
      </button>
      <p className="dim" style={{ fontSize: 13, marginBottom: 0 }}>The price is fixed by the curve; the mint refuses the trade if it moves against your limit.</p>
    </div>
  );
}

function Tile({ k, v, tone, sub }: { k: string; v: React.ReactNode; tone?: string; sub?: string }) {
  return <div className={`tile-stat ${tone ?? ''}`}><span className="label">{k}</span><b>{v}</b>{sub && <span className="tile-sub">{sub}</span>}</div>;
}

export default function Token({ onLogin }: { onLogin: () => void }) {
  const { id } = useParams();
  const toast = useToast();
  const [a, setA] = useState<Full | null>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [vaults, setVaults] = useState<any[]>([]);
  const [audit, setAudit] = useState<any>(null);
  const [err, setErr] = useState('');
  const [chart, setChart] = useState<'price' | 'candles' | 'curve'>('price');
  const [frame, setFrame] = useState<Frame>('1T');
  const [tab, setTab] = useState<'trades' | 'vaults' | 'info'>('trades');
  const w = useWallet();
  void onLogin;

  const load = useCallback(() => {
    api('GET', `/assets/${id}`).then(setA).catch((e) => setErr(e.message));
    api('GET', `/assets/${id}/trades?limit=200`).then((r) => setTrades(r.trades)).catch(() => {});
    api('GET', `/assets/${id}/vaults`).then((r) => setVaults(r.vaults)).catch(() => {});
    api('GET', `/audit/assets/${id}/status`).then(setAudit).catch(() => {});
  }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  const mine = useMemo(() => (a?.keyset_id ? w.balance(a.keyset_id) : 0), [a, w]);

  if (err) return <div className="px red" style={{ marginTop: 20 }}>{err}</div>;
  if (!a) return <div className="px" style={{ marginTop: 20 }}><div className="skel" style={{ height: 160 }} /></div>;
  const pct = Number((BigInt(a.supply) * 10000n) / 21_000_000n) / 100;
  const st = audit?.asset_status ?? 'UNKNOWN';
  const stTone = st === 'VERIFIED' ? 'green' : st === 'STALE' || st === 'UNKNOWN' ? 'yellow' : 'red';
  const npub = nip19.npubEncode(a.creator_pubkey);
  const copy = (text: string, msg: string) => navigator.clipboard.writeText(text).then(() => toast(msg, 'ok'));

  return (
    <div className="grid two token-page" style={{ marginTop: 20 }}>
      <div className="col">
        {/* ───── hero ───── */}
        <div className="px t-hero2">
          <img className="t-avatar" src={imageUrl(a.asset_id)} alt={a.name} />
          <div className="t-main">
            <div className="t-top">
              <div className="t-name">
                <h1>{a.name}</h1>
                <span className="tag yellow">${a.ticker}</span>
              </div>
              <button className="icon-pill" onClick={() => copy(window.location.href, 'Link copied')} title="Copy link" aria-label="Copy link"><PixelIcon name="copy" size={16} /></button>
            </div>
            <p className="t-desc">{a.description || <span className="dim">No description</span>}</p>
            <div className="t-meta">
              <div className="seg">
                <span className="seg-label" title={npub}><PixelIcon name="user" size={13} />{shortKey(a.creator_pubkey)}</span>
                <button className="seg-btn" onClick={() => copy(npub, 'Creator npub copied')} title="Copy creator npub" aria-label="Copy creator npub"><PixelIcon name="copy" size={13} /></button>
                <a className="seg-btn" href={`https://primal.net/p/${npub}`} target="_blank" rel="noopener noreferrer" title="Open the creator's profile on Primal"><NostrIcon size={14} />Nostr ↗</a>
              </div>
              <div className="t-status">
                <span className="status" title="Audit self-check"><i className={`sd ${stTone}`} />{st}</span>
                <span className="status" title="Nostr announcement"><i className="sd" />{a.announcement_state.replace('ANNOUNCEMENT_', '').toLowerCase()}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ───── key numbers ───── */}
        <div className="statgrid">
          <Tile k="Price" v={<>{fmtPrice(a.price_nano)}<small> sat</small></>} tone="big" />
          <Tile k="Supply sold" v={`${pct}%`} />
          <Tile k="Reserve" v={<>{fmt(a.reserve_sats)}<small> sats</small></>} />
          <Tile k="Volume" v={<>{fmt(a.volume_sats)}<small> sats</small></>} />
          <Tile k="Fees earned" v={<>{fmt(a.fees_total ?? 0)}<small> sats</small></>} sub={`creators ${fmt(a.creator_fees ?? 0)} · buyback ${fmt(a.buyback_fees ?? 0)}`} />
          <Tile k="Trades" v={fmt(a.trade_count)} />
          <Tile k="Burned" v={fmt(a.burned_supply ?? 0)} sub="bought back with the 0.7% fee" />
          <Tile k="Locked" v={fmt(a.locked_supply)} />
        </div>

        <div className="px">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <span className="label">Bonding curve progress</span>
            <span className="mono">{fmt(a.supply)} / 21,000,000</span>
          </div>
          <div className="bar tall"><i style={{ width: `${Math.max(pct, 0.6)}%` }} /><s style={{ left: '25%' }} /><s style={{ left: '50%' }} /><s style={{ left: '75%' }} /></div>
        </div>

        {/* ───── charts ───── */}
        <div className="px">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>{chart === 'price' ? 'Price history' : chart === 'candles' ? 'Candlesticks' : 'Bonding curve'}</h3>
            <div className="pills">
              <button className={`pill ${chart === 'price' ? 'on' : ''}`} onClick={() => setChart('price')}>Price</button>
              <button className={`pill ${chart === 'candles' ? 'on' : ''}`} onClick={() => setChart('candles')}>Candles</button>
              <button className={`pill ${chart === 'curve' ? 'on' : ''}`} onClick={() => setChart('curve')}>Curve</button>
            </div>
          </div>
          {chart === 'candles' && (
            <div className="pills" style={{ marginBottom: 10 }}>
              {FRAMES.map(([k, lab]) => <button key={k} className={`pill ${frame === k ? 'on' : ''}`} onClick={() => setFrame(k)}>{lab}</button>)}
            </div>
          )}
          {chart === 'price' && <PriceChart trades={trades} vaults={vaults} />}
          {chart === 'candles' && <CandleChart trades={trades} vaults={vaults} frame={frame} />}
          {chart === 'curve' && <CurveChart supply={BigInt(a.supply)} />}
          {chart !== 'curve' && (
            <div className="chart-legend">
              <span><i style={{ background: '#3ddc84' }} />price up</span>
              <span><i style={{ background: '#ff7088' }} />price down</span>
              <span><i style={{ background: '#4fd9ff' }} />DEV BUY: the launch buy by the creator</span>
              <span><i style={{ background: '#ffb627' }} />LOCK: tokens locked in a vault</span>
              <span className="dim">Later trades are anonymous by design, so dev sells cannot be identified.</span>
            </div>
          )}
        </div>

        {/* ───── tabs ───── */}
        <div className="px">
          <div className="pills" style={{ marginBottom: 12 }}>
            <button className={`pill ${tab === 'trades' ? 'on' : ''}`} onClick={() => setTab('trades')}>Trades <span className="count">{trades.length}</span></button>
            <button className={`pill ${tab === 'vaults' ? 'on' : ''}`} onClick={() => setTab('vaults')}>Locked <span className="count">{vaults.length}</span></button>
            <button className={`pill ${tab === 'info' ? 'on' : ''}`} onClick={() => setTab('info')}>Manifest</button>
          </div>

          {tab === 'trades' && (
            trades.length === 0 ? <div className="dim">No trades yet.</div> : (
              <div className="feed">
                {trades.map((t) => (
                  <div key={t.trade_id} className="feed-row" title={`audit seq ${t.audit_seq}\nreceipt ${t.receipt_sig}`}>
                    <NutImg k={t.side === 'BUY' ? 'walt' : 'pista'} size={32} />
                    <span className="dim">#{t.seq}</span>
                    <span className={`who ${t.side === 'BUY' ? 'green' : 'red'}`}>{t.side === 'BUY' ? 'bought' : 'sold'}</span>
                    <b>{fmt(t.delta_units)}</b>
                    <span className="dim">for {fmt(t.gross_sats)} sats</span>
                    <span className="grow" />
                    <span className="dim">{ago(t.created_at)}</span>
                    <span className="mono dim">{t.receipt_sig.slice(0, 8)}…</span>
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'vaults' && (
            <>
              {vaults.length === 0 ? <div className="dim">No vaults. The creator's first buy is not a claim of current holdings.</div> : (
                <div className="scroll"><table>
                  <thead><tr><th>Vault</th><th>Amount</th><th>Unlock</th><th>State</th><th>Commitment</th></tr></thead>
                  <tbody>{vaults.map((v) => (
                    <tr key={v.vault_id}><td className="mono">{v.vault_id.slice(0, 8)}…</td><td>{fmt(v.amount)}</td>
                      <td>{new Date(v.unlock_at).toLocaleString()}</td><td><span className="tag">{v.state}</span></td>
                      <td className="mono">{v.beneficiary_commitment.slice(0, 12)}…</td></tr>
                  ))}</tbody>
                </table></div>
              )}
              <p className="dim" style={{ fontSize: 14, marginBottom: 0 }}>Enforced by the mint application, not by cryptography.</p>
            </>
          )}

          {tab === 'info' && (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
              <div>
                <Stat k="Unit" v={<span className="mono">{a.unit}</span>} />
                <Stat k="Asset ID" v={<span className="mono">{a.asset_id.slice(0, 16)}…</span>} />
                <Stat k="Keyset" v={<span className="mono">{a.keyset_id}</span>} />
                <Stat k="Creator first buy" v={fmt(a.creator_initial_units)} />
                <Stat k="Manifest hash" v={<span className="mono">{a.manifest_hash.slice(0, 12)}…</span>} />
              </div>
              <div>
                <label>Creator fee split (0.3% of each trade, immutable)</label>
                {a.fee_split.map((f) => <Stat key={f.pubkey} k={shortKey(f.pubkey)} v={`${f.bps / 100}%`} />)}
              </div>
              <details style={{ gridColumn: '1 / -1' }}><summary>Signed manifest event</summary>
                <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(a.manifest_event, null, 2)}</pre>
              </details>
            </div>
          )}
        </div>
      </div>

      {/* ───── right: sticky trade ───── */}
      <div className="col sticky-col">
        <TradePanel asset={a} onDone={load} />
        <div className="px holdbox">
          <div>
            <div className="label">You hold</div>
            <b className="yellow" style={{ fontSize: 22 }}>{fmt(mine)}</b> <span className="dim">{a.ticker}</span>
          </div>
          <Link to="/wallet" className="btn sm">Wallet</Link>
        </div>
      </div>
    </div>
  );
}
