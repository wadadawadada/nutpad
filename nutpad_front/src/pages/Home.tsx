import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmt, fmtPrice } from '../lib/format';
import { Nut } from '../components/Nut';
import { TokenCard, type AssetView } from './Explore';

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
            <Link to="/explore" className="btn ghost hero-cta">Explore tokens</Link>
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

export default function Home() {
  const [assets, setAssets] = useState<AssetView[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api<{ assets: AssetView[] }>('GET', '/assets?sort=volume').then((r) => alive && setAssets(r.assets)).catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => { alive = false; clearInterval(t); };
  }, []);

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

      {assets && assets.length > 0 && (
        <>
          <div className="section-title"><h2>Top tokens</h2><Link to="/explore" className="tag cyan">See all</Link></div>
          <div className="grid cards" style={{ marginTop: 18 }}>
            {assets.slice(0, 3).map((a, i) => <TokenCard key={a.asset_id} a={a} rank={i} />)}
          </div>
        </>
      )}
    </>
  );
}
