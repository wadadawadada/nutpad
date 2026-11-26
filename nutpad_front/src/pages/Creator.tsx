import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { nip19 } from 'nostr-tools';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmt, shortKey } from '../lib/format';
import { useProfile } from '../lib/profile';
import { PixelIcon } from '../components/PixelIcon';
import { NostrIcon } from '../components/NostrIcon';
import { NutImg } from '../components/Nut';
import { useToast } from '../components/ui';
import { TokenCard, type AssetView } from './Explore';

/** npub or hex → hex pubkey (null if it is neither). */
function toHex(id: string): string | null {
  if (/^[0-9a-f]{64}$/i.test(id)) return id.toLowerCase();
  try {
    const d = nip19.decode(id);
    return d.type === 'npub' ? d.data : null;
  } catch {
    return null;
  }
}

function Tile({ k, v, sub }: { k: string; v: React.ReactNode; sub?: string }) {
  return <div className="tile-stat"><span className="label">{k}</span><b>{v}</b>{sub && <span className="tile-sub">{sub}</span>}</div>;
}

export default function Creator() {
  const { id = '' } = useParams();
  const hex = useMemo(() => toHex(id), [id]);
  const auth = useAuth();
  const toast = useToast();
  const prof = useProfile(hex);
  const [assets, setAssets] = useState<AssetView[] | null>(null);
  const [err, setErr] = useState('');
  const [imgOk, setImgOk] = useState(true);

  useEffect(() => {
    if (!hex) return;
    let alive = true;
    const load = () => api<{ assets: AssetView[] }>('GET', `/assets?creator=${hex}&sort=volume`)
      .then((r) => alive && (setAssets(r.assets), setErr('')))
      .catch((e) => alive && setErr(e.message));
    load();
    const t = setInterval(load, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [hex]);
  useEffect(() => { setImgOk(true); }, [prof.picture]);

  if (!hex) return <div className="px red" style={{ marginTop: 20 }}>This is not a valid Nostr address.</div>;
  const npub = nip19.npubEncode(hex);
  const isMe = auth.pubkey === hex;
  const sum = (f: (a: AssetView) => bigint) => (assets ?? []).reduce((acc, a) => acc + f(a), 0n);
  const volume = sum((a) => BigInt(a.volume_sats));
  const trades = sum((a) => BigInt(a.trade_count));
  const burned = sum((a) => BigInt(a.burned_supply ?? 0));
  const fees = sum((a) => BigInt(a.creator_fees ?? 0));

  return (
    <div style={{ marginTop: 20 }} className="col">
      <div className="px creator-hero">
        <div className="creator-avatar">
          {prof.picture && imgOk
            ? <img src={prof.picture} alt="" referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
            : <NutImg k="cashu" size={56} />}
        </div>
        <div className="creator-info">
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <h1 style={{ margin: 0 }}>{prof.name ?? shortKey(hex)}</h1>
            {isMe && <span className="tag green">you</span>}
          </div>
          {prof.about && <p className="dim" style={{ margin: '6px 0 0' }}>{prof.about}</p>}
          <div className="seg" style={{ marginTop: 10 }}>
            <span className="seg-label" title={npub}><PixelIcon name="user" size={13} />{shortKey(hex)}</span>
            <button className="seg-btn" onClick={() => navigator.clipboard.writeText(npub).then(() => toast('npub copied', 'ok'))} title="Copy npub" aria-label="Copy npub"><PixelIcon name="copy" size={13} /></button>
            <a className="seg-btn" href={`https://primal.net/p/${npub}`} target="_blank" rel="noopener noreferrer" title="Open on Primal"><NostrIcon size={14} />Nostr ↗</a>
          </div>
        </div>
      </div>

      <div className="statgrid">
        <Tile k="Tokens launched" v={assets ? assets.length : '…'} />
        <Tile k="Total volume" v={<>{fmt(volume)}<small> sats</small></>} sub={`${fmt(trades)} trades`} />
        <Tile k="Burned" v={fmt(burned)} sub="bought back with the 0.7% fee" />
        <Tile k="Creator fees earned" v={<>{fmt(fees)}<small> sats</small></>} sub="0.3% of every trade" />
      </div>

      <div className="section-title"><h2>Tokens by {prof.name ?? shortKey(hex)}</h2></div>
      {err && <div className="px red">{err}</div>}
      {assets && assets.length === 0 && (
        <div className="px">No tokens launched yet.{isMe && <> <Link to="/create">Launch your first one</Link>.</>}</div>
      )}
      <div className="grid cards">
        {assets?.map((a, i) => <TokenCard key={a.asset_id} a={a} rank={assets.length > 1 && i < 3 ? i : undefined} />)}
      </div>
    </div>
  );
}
