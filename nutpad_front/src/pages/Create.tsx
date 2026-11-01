import { NostrIcon } from '../components/NostrIcon';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { api, imageUrl, API_URL } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MAX_FIRST_BUY_UNITS, MIN_FIRST_BUY_SATS, LAUNCH_FEE_SATS, quoteBuyBudget, quoteBuyUnits } from '../lib/curve';
import { errMsg, fmt, parsePubkey } from '../lib/format';
import { runOp, satKeysetId, selectProofs, useWallet } from '../lib/wallet';
import { PixelIcon } from '../components/PixelIcon';
import { Field, Stat, useAction, useCelebrate, useToast } from '../components/ui';
import { Nut } from '../components/Nut';

interface Recipient { key: string; pct: string }

const sniff = (b: Uint8Array) => {
  const h = (s: string) => bytesToHex(b.slice(0, s.length / 2)) === s;
  if (h('89504e47')) return 'image/png';
  if (h('ffd8ff')) return 'image/jpeg';
  if (h('47494638')) return 'image/gif';
  if (b.length > 12 && h('52494646') && bytesToHex(b.slice(8, 12)) === '57454250') return 'image/webp';
  return null;
};
const toB64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

export default function Create({ onLogin }: { onLogin: () => void }) {
  const auth = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const celebrate = useCelebrate();
  const w = useWallet();
  const { busy, run } = useAction();
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [desc, setDesc] = useState('');
  const [img, setImg] = useState<{ bytes: Uint8Array; mime: string; url: string } | null>(null);
  const [recips, setRecips] = useState<Recipient[]>([{ key: '', pct: '100' }]);
  const [budget, setBudget] = useState('1000');
  const [sat, setSat] = useState('');
  const [step, setStep] = useState('');
  const [post, setPost] = useState(true);
  const [mintPk, setMintPk] = useState('');
  useEffect(() => {
    satKeysetId().then(setSat).catch(() => {});
    api('GET', '/v1/info').then((i) => setMintPk(i.pubkey)).catch(() => {});
  }, []);

  const quote = useMemo(() => {
    if (!/^\d+$/.test(budget)) return null;
    const q = quoteBuyBudget(0n, BigInt(budget), MAX_FIRST_BUY_UNITS);
    return q && q.total >= MIN_FIRST_BUY_SATS ? q : null;
  }, [budget]);
  const need = quote ? Number(quote.total + LAUNCH_FEE_SATS) : 0;
  const have = sat ? w.balance(sat) : 0;
  const pctSum = recips.reduce((a, r) => a + (Number(r.pct) || 0), 0);

  const pickImage = async (f: File | undefined) => {
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const mime = sniff(bytes);
    if (!mime) return toast('Use PNG, JPEG, GIF or WebP', 'err');
    if (bytes.length > 256 * 1024) return toast('Image must be ≤ 256 KB', 'err');
    setImg({ bytes, mime, url: URL.createObjectURL(f) });
  };

  const submit = () =>
    run(async () => {
      if (!auth.pubkey) throw new Error('Log in with Nostr first');
      if (!img) throw new Error('Add an image');
      if (!quote) throw new Error(`First buy must be at least ${MIN_FIRST_BUY_SATS} sats`);
      if (Math.abs(pctSum - 100) > 1e-9) throw new Error('Fee split must total 100%');
      const fee_split = recips.map((r) => {
        const pk = parsePubkey(r.key || auth.npub!);
        if (!pk) throw new Error(`Invalid Nostr pubkey: ${r.key}`);
        const bps = Math.round(Number(r.pct) * 100);
        if (!(bps >= 1)) throw new Error('Each recipient needs at least 0.01%');
        return { pubkey: pk, bps };
      });
      const manifest = {
        v: 1, nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))), issuer: mintPk, creator: auth.pubkey,
        name: name.trim(), ticker: ticker.trim().toUpperCase(), description: desc.trim(),
        image_hash: bytesToHex(sha256(img.bytes)), image_mime: img.mime, supply: '21000000',
        curve: { type: 'linear', start_price_nano: '1000000', reserve_total: '1000000' },
        fee_split,
        launch: { fee_sats: '1000', min_first_buy_sats: '100', max_first_buy_units: '2100000' },
      };
      const q = await api('POST', '/assets/launch/quote', { manifest, units: quote.delta.toString() });
      setStep('1/2 Approve the manifest signature in your signer app…');
      const signer = await auth.getSigner();
      const event = await signer.signEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', manifest.nonce], ['t', 'nutpad-manifest']], content: q.content });
      const url = `${window.location.origin}/token/${q.asset_id}`;
      setStep(post ? '2/2 Approve the Nostr post in your signer app…' : '');
      const note = !post ? undefined : await signer.signEvent({
        kind: 1, created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'nutpad'], ['r', url]],
        content: [`Launched $${manifest.ticker} — ${manifest.name} on nutpad`, manifest.description.slice(0, 300), url].filter(Boolean).join('\n\n'),
      });
      setStep('Settling launch with the mint…');
      const satKs = await satKeysetId();
      const total = Number(quote.total + LAUNCH_FEE_SATS);
      const inputs = selectProofs(satKs, total);
      const inSum = inputs.reduce((a, p) => a + p.amount, 0);
      const r = await runOp({
        kind: 'launch', path: '/assets/launch', inputs,
        extra: { manifest_event: event, announce_event: note, image_b64: toB64(img.bytes), delta: quote.delta.toString() },
        groups: [
          { name: 'asset', keysetId: q.keyset_id, field: 'signatures_asset', total: quote.delta },
          { name: 'sat', keysetId: satKs, field: 'signatures_sat', total: inSum - total },
        ],
      });
      celebrate({ stamp: 'LAUNCHED!', nut: 'pista', text: `$${manifest.ticker} is live. Trading is open!` });
      nav(`/token/${r.response.asset_id}`);
    }).finally(() => setStep(''));

  if (!auth.pubkey)
    return <div className="px hot" style={{ marginTop: 24 }}><h2>Create token</h2><p>Log in with Nostr to sign your immutable launch manifest.</p><button onClick={onLogin}><NostrIcon size={18} />Nostr Login</button></div>;

  return (
    <div className="grid two" style={{ marginTop: 20 }}>
      <div className="px col cform">
        <div className="cform-head">
          <Nut k="pista" scale={2} />
          <div>
            <h2 style={{ margin: 0 }}>Create token</h2>
            <div className="dim" style={{ fontSize: 13 }}>Name it, draw it, sign it. The manifest is forever.</div>
          </div>
        </div>

        <div className="cform-top">
          <div className="cform-img">
            <span className="lbl">Image</span>
            <label className={`drop ${img ? 'has' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void pickImage(e.dataTransfer.files?.[0]); }}>
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => pickImage(e.target.files?.[0])} />
              {img ? <img src={img.url} alt="token preview" /> : <span><b>+</b>Upload</span>}
            </label>
          </div>
          <div className="cform-fields">
            <div className="two-col">
              <Field label="Name"><input maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="Peanut Butter Jar" /></Field>
              <Field label="Ticker"><input maxLength={10} value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="PBJ" /></Field>
            </div>
            <Field label={`Description · ${desc.length}/500`}><textarea rows={3} maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What is this token about?" /></Field>
          </div>
        </div>
        <div className="dim" style={{ fontSize: 12 }}>Image: PNG, JPEG, GIF or WebP up to 256 KB, pinned by its SHA-256. Ticker: 2–10 characters A–Z 0–9.</div>
        <h3 style={{ marginTop: 4 }}>Creator fee split · immutable</h3>
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>0.3% of every trade goes to these Nostr keys. It can never be changed. Empty key = you.</p>
        {recips.map((r, i) => (
          <div className="row" key={i}>
            <input className="grow" placeholder={i === 0 ? 'npub1… or hex (empty = you)' : 'npub1… or hex'} value={r.key} onChange={(e) => setRecips(recips.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            <input style={{ width: 90 }} value={r.pct} onChange={(e) => setRecips(recips.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} />
            <span>%</span>
            {recips.length > 1 && <button className="ghost sm" onClick={() => setRecips(recips.filter((_, j) => j !== i))}>–</button>}
          </div>
        ))}
        <div className="row">
          <button className="ghost sm" disabled={recips.length >= 20} onClick={() => setRecips([...recips, { key: '', pct: '0' }])}>+ recipient</button>
          <span className={Math.abs(pctSum - 100) < 1e-9 ? 'green' : 'red'}>total {pctSum}%</span>
        </div>
      </div>

      <div className="col">
        <div className="px hot">
          <h3>Launch quote</h3>
          <Field label="First buy budget (sats, ≥100, max 10% supply)">
            <input inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, ''))} />
          </Field>
          {quote ? (<div style={{ marginTop: 8 }}>
            <Stat k="Launch fee (outside reserve)" v={`${fmt(LAUNCH_FEE_SATS)} sats`} />
            <Stat k="First buy units" v={<b className="green">{fmt(quote.delta)}</b>} />
            <Stat k="Curve cost" v={`${fmt(quote.gross)} sats`} />
            <Stat k="Trade fee 1%" v={`${fmt(quote.fee)} sats`} />
            <Stat k="Total to pay" v={<b className="yellow">{fmt(need)} sats</b>} />
            <Stat k="Wallet" v={<span className={have >= need ? 'green' : 'red'}>{fmt(have)} sats</span>} />
          </div>) : <div className="red">Budget too small or too large (first buy: 100 sats up to 10% of supply).</div>}
          <p className="dim" style={{ fontSize: 16 }}>Max first buy: {fmt(quoteBuyUnits(0n, MAX_FIRST_BUY_UNITS).total)} sats. The launch is one atomic transaction; retries never create duplicates.</p>
          <button style={{ width: '100%' }} disabled={busy || !quote || have < need || !name || ticker.length < 2 || !img} onClick={submit}>
            {busy ? 'Working…' : 'Sign manifest & launch'}
          </button>
          {step && <p className="yellow">{step}</p>}
          <label style={{ marginTop: 10 }}><input type="checkbox" style={{ width: 'auto' }} checked={post} onChange={(e) => setPost(e.target.checked)} /> Also publish a Nostr post (needs a 2nd approval)</label>
          {post && /localhost|127\.0\.0\.1/.test(API_URL) && <p className="dim" style={{ fontSize: 13 }}>Heads up: the post links to localhost, so other people can only open it after the app is deployed.</p>}
          {have < need && <p className="red">Not enough sats — use the faucet in the Wallet tab.</p>}
        </div>
        <div className="px">
          <h3>What happens</h3>
          <ol className="dim" style={{ paddingLeft: 20, margin: 0 }}>
            <li>You sign an immutable manifest with Nostr.</li>
            <li>The mint settles launch + trade #1 atomically.</li>
            <li>Trading opens immediately; the Nostr announcement is delivered in the background.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
void imageUrl; void errMsg;
