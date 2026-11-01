import { NostrIcon } from '../components/NostrIcon';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmt, parsePubkey, shortKey } from '../lib/format';
import { runOp, selectProofs, useWallet } from '../lib/wallet';
import { PixelIcon } from '../components/PixelIcon';
import { Field, Stat, useAction, useToast } from '../components/ui';
import type { AssetView } from './Explore';
import { NutSays } from '../components/Nut';

export default function Vault({ onLogin }: { onLogin: () => void }) {
  const auth = useAuth();
  const w = useWallet();
  const toast = useToast();
  const { busy, run } = useAction();
  const [assets, setAssets] = useState<AssetView[]>([]);
  const [vaults, setVaults] = useState<any[]>([]);
  const [info, setInfo] = useState<any>(null);
  const [assetId, setAssetId] = useState('');
  const [ben, setBen] = useState('');
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState('7d');

  const load = useCallback(() => {
    api('GET', '/assets?sort=new').then((r) => setAssets(r.assets)).catch(() => {});
    api('GET', '/v1/info').then(setInfo).catch(() => {});
    if (auth.pubkey) api('GET', '/vaults').then((r) => setVaults(r.vaults)).catch(() => {});
  }, [auth.pubkey]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  if (!auth.pubkey) return <div className="px hot" style={{ marginTop: 24 }}><h2>Creator Vault</h2><p>Log in to lock tokens or claim vaults sent to you.</p><button onClick={onLogin}><NostrIcon size={18} />Nostr Login</button></div>;

  const mine = assets.filter((a) => a.creator_pubkey === auth.pubkey);
  const asset = assets.find((a) => a.asset_id === assetId);
  const held = asset?.keyset_id ? w.balance(asset.keyset_id) : 0;

  const lock = () => run(async () => {
    if (!asset?.keyset_id) throw new Error('Select an asset');
    const pk = parsePubkey(ben || auth.npub!);
    if (!pk) throw new Error('Invalid beneficiary pubkey');
    const amt = Number(amount);
    const inputs = selectProofs(asset.keyset_id, amt);
    const inSum = inputs.reduce((a, p) => a + p.amount, 0);
    const r = await runOp({
      kind: 'vault-lock', path: '/vaults/lock', inputs,
      extra: { asset_id: asset.asset_id, beneficiary_pubkey: pk, duration, amount: String(amt) },
      groups: [{ name: 'asset', keysetId: asset.keyset_id, field: 'signatures', total: inSum - amt }],
    });
    toast(`Locked ${fmt(amt)} ${asset.ticker}. Receipt audit seq #${r.response.receipt.audit_sequence}`, 'ok');
    setAmount('');
    load();
  });

  const claim = (v: any) => run(async () => {
    const a = assets.find((x) => x.asset_id === v.asset_id);
    if (!a?.keyset_id) throw new Error('Unknown asset');
    await runOp({
      kind: 'vault-claim', path: `/vaults/${v.vault_id}/claim`, inputs: [], inputsField: null,
      groups: [{ name: 'asset', keysetId: a.keyset_id, field: 'signatures', total: Number(v.amount) }],
    });
    load();
  }, 'Vault claimed into your wallet');

  return (
    <div className="grid two" style={{ marginTop: 20 }}>
      <div className="px col">
        <NutSays k="hazel" prop="lock" text="Lock tokens on purpose and show everyone you are not dumping." />
        <h2>Lock tokens</h2>
        <p className="dim" style={{ marginTop: 0 }}>Voluntarily lock tokens you bought. The beneficiary is fixed now and hidden behind a commitment; the supply does not shrink.</p>
        <Field label="Asset (you are creator)">
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">select…</option>
            {mine.map((a) => <option key={a.asset_id} value={a.asset_id}>${a.ticker} — {a.name}</option>)}
          </select>
        </Field>
        <Field label="Beneficiary (npub / hex, empty = you)"><input value={ben} onChange={(e) => setBen(e.target.value)} placeholder="npub1…" /></Field>
        <Field label={`Amount (wallet: ${fmt(held)})`}><input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="Duration">
          <select value={duration} onChange={(e) => setDuration(e.target.value)}>
            <option value="7d">7 days</option><option value="30d">30 days</option><option value="90d">90 days</option>
            {info?.demo_mode && <option value="demo">Demo (short)</option>}
          </select>
        </Field>
        <button disabled={busy || !asset || !amount || Number(amount) > held || Number(amount) < 1} onClick={lock}>Lock tokens</button>
        <p className="dim" style={{ fontSize: 16, margin: 0 }}>Enforced by the mint application, not by cryptography. Beneficiary claims with Nostr login after unlock.</p>
      </div>

      <div className="px">
        <h2>My vaults</h2>
        {vaults.length === 0 && <div className="dim">Nothing here yet.</div>}
        {vaults.map((v) => (
          <div key={v.vault_id} className="px" style={{ background: 'var(--panel2)' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>{fmt(v.amount)} ${v.ticker}</b>
              <span className={`tag ${v.state === 'CLAIMABLE' ? 'green' : v.state === 'CLAIMED' ? '' : 'yellow'}`}>{v.state}</span>
            </div>
            <Stat k="Unlock" v={new Date(v.unlock_at).toLocaleString()} />
            <Stat k="Role" v={v.role.join(' + ')} />
            <Stat k="Beneficiary" v={shortKey(v.beneficiary_pubkey)} />
            <Stat k="Vault ID" v={<span className="mono">{v.vault_id.slice(0, 12)}…</span>} />
            {v.state === 'CLAIMABLE' && v.role.includes('beneficiary') && (
              <button className="green" disabled={busy} style={{ marginTop: 8 }} onClick={() => claim(v)}>Claim to wallet</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
