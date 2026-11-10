import { GithubLink } from './components/GithubIcon';
import { NostrIcon } from './components/NostrIcon';
import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { useProfileName } from './lib/profile';
import { rememberMintPk } from './lib/relaylog';
import { api } from './lib/api';
import { checkDeposits, refreshKeysets, resumePending, satKeysetId, useWallet } from './lib/wallet';
import { errMsg, fmt, shortKey } from './lib/format';
import { PixelIcon } from './components/PixelIcon';
import { useToast } from './components/ui';
import LoginModal from './components/LoginModal';
import Banner from './components/Banner';
import { NutImg } from './components/Nut';
import Home from './pages/Home';
import Explore from './pages/Explore';
import Token from './pages/Token';
import Create from './pages/Create';
import WalletPage from './pages/Wallet';
import Vault from './pages/Vault';
import Audit from './pages/Audit';

export default function App() {
  const auth = useAuth();
  const profileName = useProfileName(auth.pubkey);
  const w = useWallet();
  const [login, setLogin] = useState(false);
  const [info, setInfo] = useState<any>(null);
  const [sat, setSat] = useState<string>('');
  const toast = useToast();

  useEffect(() => {
    api('GET', '/v1/info').then((i: any) => { setInfo(i); if (i?.pubkey) rememberMintPk(i.pubkey); }).catch((e) => toast('API unreachable: ' + errMsg(e), 'err'));
    refreshKeysets().then(satKeysetId).then(setSat).then(resumePending).catch(() => {});
    const t = setInterval(() => { void resumePending(); void checkDeposits(); }, 15000);
    void checkDeposits();
    return () => clearInterval(t);
  }, [toast]);

  return (
    <>
      {info?.ln?.enabled && info.ln.network !== 'mainnet' && (
        <div className="notice">{String(info.ln.network).toUpperCase()} — Lightning testnet coins, no real value{info.demo_faucet ? ' · demo faucet is ON (unbacked sats)' : ''}</div>
      )}
      {info && !info.ln?.enabled && info.demo_faucet && (
        <div className="notice">DEMO MODE — sats come from a test faucet and are not backed by real bitcoin</div>
      )}
      <Banner />
      <header className="top">
        <div className="bar-in">
          <nav>
            <NavLink to="/" end aria-label="Home" title="Home"><PixelIcon name="home" size={18} /></NavLink>
            <NavLink to="/explore"><PixelIcon name="explore" size={18} />Explore</NavLink>
            <NavLink to="/create"><PixelIcon name="create" size={18} />Create</NavLink>
            <NavLink to="/vault"><PixelIcon name="vault" size={18} />Vault</NavLink>
            <NavLink to="/audit"><PixelIcon name="audit" size={18} />Audit</NavLink>
          </nav>
          <span className="grow" />
          <NavLink to="/wallet" className="tag yellow" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><PixelIcon name="wallet" size={20} />{sat ? fmt(w.balance(sat)) : '…'} sats</NavLink>
          {auth.pubkey ? (
            <div className="row" style={{ gap: 8 }}>
              <a className="tag cyan npub" href={`https://primal.net/p/${auth.npub}`} target="_blank" rel="noopener noreferrer" title="Open your Primal profile"><PixelIcon name="user" size={14} />{profileName ?? shortKey(auth.pubkey)}</a>
              <button className="ghost sm icon-btn" onClick={() => auth.logout()} title="Logout" aria-label="Logout"><PixelIcon name="logout" size={18} /></button>
            </div>
          ) : (
            <button className="sm" onClick={() => setLogin(true)}><NostrIcon size={18} />Nostr Login</button>
          )}
          <GithubLink size={22} />
        </div>
      </header>
      <main className="wrap">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/explore" element={<Explore />} />
          <Route path="/token/:id" element={<Token onLogin={() => setLogin(true)} />} />
          <Route path="/create" element={<Create onLogin={() => setLogin(true)} />} />
          <Route path="/wallet" element={<WalletPage onLogin={() => setLogin(true)} />} />
          <Route path="/vault" element={<Vault onLogin={() => setLogin(true)} />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="*" element={<div className="px">Not found</div>} />
        </Routes>
      </main>
      <footer className="wrap footer">
        <p><NutImg k="cashu" size={20} /> nutpad — demo build. Ecash mints are custodial; the audit log proves consistency, not BTC backing.</p>
      </footer>
      {login && <LoginModal onClose={() => setLogin(false)} />}
    </>
  );
}
