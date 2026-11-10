import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, imageUrl } from '../lib/api';
import { fmt, fmtPrice, shortKey } from '../lib/format';
import { Nut, NutImg } from '../components/Nut';
import { knownMintPk, loadFromRelays, type RelayView } from '../lib/relaylog';


export interface AssetView {
  asset_id: string; unit: string; name: string; ticker: string; description: string; creator_pubkey: string;
  supply: string; reserve_sats: string; locked_supply: string; price_nano: string; trade_count: string; volume_sats: string;
  fees_total?: string; creator_fees?: string; buyback_fees?: string; burned_supply?: string;
  keyset_id: string | null; creator_initial_units: string; announcement_state: string; manifest_hash: string; created_at: string;
}

const SORTS = [['new', 'New'], ['volume', 'Top volume'], ['momentum', 'Top momentum']] as const;

export function TokenCard({ a, rank }: { a: AssetView; rank?: number }) {
  const pct = Number((BigInt(a.supply) * 10000n) / 21_000_000n) / 100;
  return (
    <Link to={`/token/${a.asset_id}`} className="px token-card">
      <div className="card-img">
        <img className="img" src={imageUrl(a.asset_id)} alt={a.name} loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
        {rank !== undefined && <span className="tag yellow card-rank">#{rank + 1}</span>}
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
}

export default function Explore() {
  const [sort, setSort] = useState<string>('new');
  const [assets, setAssets] = useState<AssetView[] | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [err, setErr] = useState('');
  const [relayView, setRelayView] = useState<RelayView | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ assets: AssetView[] }>('GET', `/assets?sort=${sort}`)
        .then((r) => alive && (setAssets(r.assets), setErr(''), setRelayView(null)))
        .catch((e) => {
          if (!alive) return;
          setErr(e.message);
          // our API is down: rebuild the list from the public log on Nostr relays
          const pk = knownMintPk();
          if (pk) loadFromRelays(pk).then((v) => alive && setRelayView(v)).catch(() => {});
        });
    load();
    api('GET', '/audit/status').then((s) => alive && setStatus(s)).catch(() => {});
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [sort]);

  return (
    <>
      <div className="section-title"><h2>Explore tokens</h2>
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
      {err && relayView ? (
        <div className="px pinkb">
          <b>Our API is unreachable.</b> These tokens are rebuilt from the public log on Nostr relays ({relayView.events} events, replayed with the same rules as the server{relayView.complete ? '' : ', log incomplete'}). Trading and token pages need the API.
        </div>
      ) : err && <div className="px red">{err}</div>}
      {assets && assets.length === 0 && (
        <div className="px row" style={{ alignItems: 'flex-end' }}><Nut k="pea" scale={4} /><div className="speech-lite">Nothing here yet! Be the first to launch a token.</div></div>
      )}
      <div className="grid cards" style={{ marginTop: 18 }}>
        {err && relayView?.tokens.map((t) => (
          <div key={t.asset_id} className="px token-card">
            <div className="meta"><span className="name">{t.name}</span><span className="tag yellow">${t.ticker}</span></div>
            <div className="pricebig">{fmtPrice(t.price_nano)} <span className="dim" style={{ fontSize: 11 }}>sat</span></div>
            <div className="stat"><span className="dim">supply</span><span>{fmt(t.supply)}</span></div>
            <div className="stat"><span className="dim">burned</span><span>{fmt(t.burned_supply)}</span></div>
            <div className="stat"><span className="dim">volume</span><span>{fmt(t.volume_sats)} sats</span></div>
            <div className="stat"><span className="dim">by</span><span>{shortKey(t.creator_pubkey)}</span></div>
          </div>
        ))}
        {assets?.map((a, idx) => <TokenCard key={a.asset_id} a={a} rank={sort !== 'new' && idx < 3 ? idx : undefined} />)}
      </div>
    </>
  );
}
