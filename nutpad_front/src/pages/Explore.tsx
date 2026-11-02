import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, imageUrl } from '../lib/api';
import { fmt, fmtPrice, shortKey } from '../lib/format';
import { Nut, NutImg } from '../components/Nut';


function Stage() {
  return (
    <section className="hero">
      <div className="hero-stars" aria-hidden="true" />
      <div className="hero-floor" aria-hidden="true"><div className="hero-floor-lines" /></div>

      <div className="hero-grid">
        <div className="hero-copy">
          <h1>
            <span>Launch</span> <em>ecash</em> <span>memes.</span><br />
            <span className="hero-line2">Trade on a <u>curve</u>.</span>
          </h1>
          <p>Every token is a Cashu ecash unit with its own keyset, a fixed linear price curve and a public, verifiable ledger.</p>
          <div className="row" style={{ gap: 14 }}>
            <Link to="/create" className="btn hero-cta">Launch a token</Link>
            <a href="#tokens" className="btn ghost hero-cta">Explore tokens</a>
          </div>
        </div>

        <div className="hero-nut" aria-hidden="true">
          <div className="hero-nut-float">
            <div className="hero-nut-spin"><Nut k="pea" scale={8} anim={false} /></div>
          </div>
          <i className="hero-nut-shadow" />
          <i className="spark s1" /><i className="spark s2" /><i className="spark s3" />
        </div>
      </div>
    </section>
  );
}

export interface AssetView {
  asset_id: string; unit: string; name: string; ticker: string; description: string; creator_pubkey: string;
  supply: string; reserve_sats: string; locked_supply: string; price_nano: string; trade_count: string; volume_sats: string;
  fees_total?: string; creator_fees?: string; buyback_fees?: string; burned_supply?: string;
  keyset_id: string | null; creator_initial_units: string; announcement_state: string; manifest_hash: string; created_at: string;
}

const SORTS = [['new', 'New'], ['volume', 'Top volume'], ['momentum', 'Top momentum']] as const;

export default function Explore() {
  const [sort, setSort] = useState<string>('new');
  const [assets, setAssets] = useState<AssetView[] | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ assets: AssetView[] }>('GET', `/assets?sort=${sort}`)
        .then((r) => alive && (setAssets(r.assets), setErr('')))
        .catch((e) => alive && setErr(e.message));
    load();
    api('GET', '/audit/status').then((s) => alive && setStatus(s)).catch(() => {});
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [sort]);

  return (
    <>
      <Stage />
      {assets && assets.length > 0 && (
        <div className="ticker"><span>{[...assets, ...assets].map((a) => `  $${a.ticker} ${fmtPrice(a.price_nano)} sat  |  vol ${fmt(a.volume_sats)}  |  ${fmt(a.trade_count)} trades  //`).join('')}</span></div>
      )}
      <div className="section-title"><h2>How it works</h2></div>
      <div className="steps">
        {([
          ['pista', 'Launch', 'Sign a manifest, pay 1,000 sats and make the first buy. Trading opens instantly.'],
          ['walt', 'Buy on the curve', 'Price rises with supply. No order book, no slippage surprises.'],
          ['cashu', 'Hold ecash', 'Tokens are Cashu proofs in your browser wallet. Send them as bearer tokens.'],
          ['al', 'Verify', 'Every trade is in a Merkle log. Run the open verifier any time.'],
        ] as const).map(([k, t, d], n) => (
          <div key={t} className="px step"><span className="num">{n + 1}</span><div className="nut-wrap"><Nut k={k} scale={2} /></div><h3>{t}</h3><p>{d}</p></div>
        ))}
      </div>

      <div className="section-title" id="tokens"><h2>Tokens</h2>
        <div className="pills">
          {SORTS.map(([k, label]) => (
            <button key={k} className={`pill ${sort === k ? 'on' : ''}`} onClick={() => setSort(k)}>
              <NutImg k={k === 'new' ? 'pista' : k === 'volume' ? 'walt' : 'pea'} size={22} />{label}
            </button>
          ))}
        </div>
        {status && (
          <Link to="/audit" className={`tag ${status.global === 'VERIFIED' ? 'green' : status.global === 'STALE' || status.global === 'UNKNOWN' ? 'yellow' : 'red'}`}>
            Ledger: {status.global}
          </Link>
        )}
      </div>
      {err && <div className="px red">{err}</div>}
      {assets && assets.length === 0 && (
        <div className="px row" style={{ alignItems: 'flex-end' }}><Nut k="pea" scale={4} /><div className="speech-lite">Nothing here yet! Be the first to launch a token.</div></div>
      )}
      <div className="grid cards" style={{ marginTop: 18 }}>
        {assets?.map((a, idx) => {
          const pct = Number((BigInt(a.supply) * 10000n) / 21_000_000n) / 100;
          return (
            <Link key={a.asset_id} to={`/token/${a.asset_id}`} className="px token-card">
              <div className="card-img">
                <img className="img" src={imageUrl(a.asset_id)} alt={a.name} loading="lazy" />
                {sort !== 'new' && idx < 3 && <span className="tag yellow card-rank">#{idx + 1}</span>}
              </div>
              <div className="meta">
                <span className="name">{a.name}</span>
                <span className="tag yellow">${a.ticker}</span>
              </div>
              <div className="pricebig">{fmtPrice(a.price_nano)} <span className="dim" style={{ fontSize: 11 }}>sat</span></div>
              <div className="bar"><i style={{ width: `${Math.max(pct, 1)}%` }} /></div>
              <div className="stat"><span className="dim">supply</span><span>{fmt(a.supply)} ({pct}%)</span></div>
              <div className="stat"><span className="dim">volume</span><span>{fmt(a.volume_sats)} sats</span></div>
              <div className="stat"><span className="dim">by</span><span>{shortKey(a.creator_pubkey)}</span></div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
