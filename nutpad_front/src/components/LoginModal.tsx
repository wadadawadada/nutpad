import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useAuth } from '../lib/auth';
import { hasNip07 } from '../lib/nostr';
import { errMsg } from '../lib/format';
import { Nut } from './Nut';
import { useToast } from './ui';

type Tab = 'qr' | 'ext' | 'bunker' | 'test';
const QR_TTL = 120;
const TABS: [Tab, string][] = [['qr', 'Scan QR'], ['ext', 'Extension'], ['bunker', 'Bunker URL'], ['test', 'Test key']];

export default function LoginModal({ onClose }: { onClose: () => void }) {
  const auth = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('qr');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [bunker, setBunker] = useState('');

  // QR flow state
  const [uri, setUri] = useState('');
  const [qr, setQr] = useState('');
  const [left, setLeft] = useState(QR_TTL);
  const [round, setRound] = useState(0);

  const success = () => {
    setDone(true);
    toast('Logged in with Nostr', 'ok');
    setTimeout(onClose, 1100);
  };
  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      success();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (tab !== 'qr' || done) return;
    let dead = false;
    setUri(''); setQr(''); setLeft(QR_TTL); setError('');
    const c = auth.startConnect();
    QRCode.toDataURL(c.uri, { margin: 1, width: 260, errorCorrectionLevel: 'M' }).then((d) => { if (!dead) { setUri(c.uri); setQr(d); } });
    c.done.then(
      async (r) => { if (!dead) { try { await auth.finishConnect(r); success(); } catch (e) { setError(errMsg(e)); } } },
      (e) => { if (!dead) setError(errMsg(e)); },
    );
    const t = setInterval(() => setLeft((s) => {
      if (s <= 1) { dead = true; c.cancel(); clearInterval(t); return 0; }
      return s - 1;
    }), 1000);
    return () => { dead = true; c.cancel(); clearInterval(t); };
  }, [tab, round]); // eslint-disable-line react-hooks/exhaustive-deps

  const expired = tab === 'qr' && left === 0 && !done;

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="px hot login" role="dialog" aria-label="Nostr login">
        <button className="ghost sm login-x" onClick={onClose} aria-label="Close">X</button>

        <div className="login-head">
          <Nut k="pea" scale={3} talking={busy || (tab === 'qr' && !!qr && !expired)} />
          <div>
            <h2>Log in with Nostr</h2>
            <div className="dim">Your key stays in your signer. nutpad only asks it to sign.</div>
          </div>
        </div>

        <div className="login-tabs" role="tablist">
          {TABS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`pill ${tab === k ? 'on' : ''}`} onClick={() => { setTab(k); setError(''); }}>{label}</button>
          ))}
        </div>

        {done ? (
          <div className="login-done"><div className="login-check">✓</div><b>Connected!</b></div>
        ) : (
          <div className="login-body">
            {tab === 'qr' && (
              <div className="login-qr">
                <div className={`qr-frame ${expired ? 'dead' : ''}`}>
                  {qr ? <img src={qr} alt="Nostr Connect QR code" /> : <div className="qr-skel" />}
                  {expired && (
                    <div className="qr-over"><b>QR expired</b><button className="sm" onClick={() => setRound((r) => r + 1)}>New QR</button></div>
                  )}
                </div>
                <div className="login-steps">
                  <ol>
                    <li>Open your signer app (<b>Primal</b>, Amber, nsec.app…)</li>
                    <li>Scan this QR code, or tap <i>Open in app</i> on your phone</li>
                    <li>Approve the connection and the signing permissions</li>
                  </ol>
                  <div className="row" style={{ gap: 8 }}>
                    <a className="btn sm" href={uri || undefined} aria-disabled={!uri}>Open in app</a>
                    <button className="ghost sm" disabled={!uri || expired} onClick={() => navigator.clipboard.writeText(uri).then(() => toast('Connection link copied', 'ok'))}>Copy link</button>
                    <button className="ghost sm" onClick={() => setRound((r) => r + 1)}>Refresh</button>
                  </div>
                  <div className={`login-status ${expired ? 'warn' : ''}`}>
                    {expired ? 'Timed out — generate a new QR.' : !qr ? 'Preparing…' : (<><i className="dot" /> Waiting for approval · {left}s</>)}
                  </div>
                </div>
              </div>
            )}

            {tab === 'ext' && (
              <div className="col">
                <p className="dim" style={{ margin: 0 }}>Use a NIP-07 browser extension such as Alby or nos2x. A popup will ask you to approve the login.</p>
                <button disabled={busy || !hasNip07()} onClick={() => attempt(auth.loginNip07)}>{busy ? 'Waiting for extension…' : 'Continue with extension'}</button>
                {!hasNip07() && <div className="login-hint">No extension detected in this browser. Install Alby or nos2x, reload the page, or use the QR tab.</div>}
              </div>
            )}

            {tab === 'bunker' && (
              <div className="col">
                <p className="dim" style={{ margin: 0 }}>Paste a <span className="mono">bunker://…</span> link or a NIP-05 address from your remote signer.</p>
                <input placeholder="bunker://… or name@domain.com" value={bunker} onChange={(e) => setBunker(e.target.value)} spellCheck={false} autoComplete="off" />
                <button className="cyan" disabled={busy || !bunker.trim()} onClick={() => attempt(() => auth.loginBunker(bunker))}>{busy ? 'Connecting… approve in your signer' : 'Connect'}</button>
              </div>
            )}

            {tab === 'test' && (
              <div className="col">
                <div className="login-hint warn">Creates a throw-away key stored in this browser. Anyone with access to this browser can use it. For testing only — never for an identity you care about.</div>
                <button className="ghost" disabled={busy} onClick={() => attempt(auth.loginBurner)}>Use a burner key</button>
              </div>
            )}

            {error && <div className="login-error" role="alert">{error}</div>}
          </div>
        )}

        <div className="login-foot">
          Keep this tab open while approving. Your Cashu wallet seed is separate from your Nostr key and never leaves this browser.
        </div>
      </div>
    </div>
  );
}
