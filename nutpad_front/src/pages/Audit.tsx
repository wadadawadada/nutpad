import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmt } from '../lib/format';
import { Stat } from '../components/ui';
import { NutSays } from '../components/Nut';

const tone = (s: string) => (s === 'VERIFIED' || s === 'RESOLVED' ? 'green' : s === 'STALE' || s === 'UNKNOWN' ? 'yellow' : 'red');

export default function Audit() {
  const [status, setStatus] = useState<any>(null);
  const [cps, setCps] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [sol, setSol] = useState<any>(null);
  const [proof, setProof] = useState<any>(null);

  useEffect(() => {
    const load = () => {
      api('GET', '/audit/status').then(setStatus).catch(() => {});
      api('GET', '/audit/checkpoints?limit=10').then((r) => setCps(r.checkpoints)).catch(() => {});
      api('GET', '/audit/solvency').then(setSol).catch(() => {});
      api('GET', '/audit/events?from=1&limit=1000').then((r) => setEvents(r.events.slice(-25).reverse())).catch(() => {});
    };
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="col" style={{ marginTop: 20 }}>
      <div className="px hot">
        <NutSays k="al" prop="magnifier" text="I check every delivery. Warning only: I never stop the market." />
        <div className="row">
          <h2 style={{ margin: 0 }}>Audit Explorer</h2>
          {status && <span className={`tag ${tone(status.global)}`}>{status.global}</span>}
          <span className="tag">WARNING ONLY — trading is never auto-stopped</span>
        </div>
        {status && <p className="dim" style={{ marginBottom: 0 }}>{status.note} Log size {status.checked_size}.</p>}
        <p className="dim" style={{ marginBottom: 0 }}>
          A consistent ledger proves internal consistency of published events only. It does not prove that BTC exists or that no hidden issuance happened. Run the open-source verifier (<span className="mono">npm run verify -- API_URL</span>) yourself.
        </p>
      </div>

      {sol && (
        <div className="px">
          <h3>Solvency dashboard</h3>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
            <div>
              <Stat k="Sat ecash outstanding" v={fmt(sol.sat_ecash_outstanding)} />
              <Stat k="Curve reserves" v={fmt(sol.curve_reserves)} />
              <Stat k="Creator fee liabilities" v={fmt(sol.creator_fee_liabilities)} />
              <Stat k="Platform fees" v={fmt(sol.platform_fees)} />
              <Stat k="Total sat obligations" v={<b>{fmt(sol.total_sat_obligations)}</b>} />
            </div>
            <div>
              <Stat k="Ledger conservation" v={<span className={sol.ledger_conserved === false ? 'red' : 'green'}>{String(sol.ledger_conserved)}</span>} />
              <Stat k="Actual BTC treasury" v={<span className="yellow">not connected</span>} />
              <Stat k="Backing status" v={<span className="tag yellow">{sol.backing_status}</span>} />
              <p className="dim" style={{ fontSize: 16 }}>{sol.note}</p>
            </div>
          </div>
          {sol.token_checks.length > 0 && (
            <table><thead><tr><th>Asset</th><th>Token proofs outstanding</th><th>Expected (supply − locked)</th><th>Proofs</th><th>Reserve = C(q)</th></tr></thead>
              <tbody>{sol.token_checks.map((t: any) => (
                <tr key={t.asset_id}><td>${t.ticker}</td><td>{fmt(t.outstanding_token_proofs)}</td><td>{fmt(t.expected)}</td>
                  <td className={t.ok ? 'green' : 'red'}>{t.ok ? 'OK' : 'MISMATCH'}</td><td className={t.curve_ok ? 'green' : 'red'}>{t.curve_ok ? 'OK' : 'MISMATCH'}</td></tr>
              ))}</tbody></table>
          )}
        </div>
      )}

      <div className="px">
        <h3>Signed checkpoints (also published to Nostr)</h3>
        <div className="scroll"><table>
          <thead><tr><th>Size</th><th>Log root</th><th>State root</th><th>When</th></tr></thead>
          <tbody>{cps.map((c) => (
            <tr key={c.size}><td>{c.size}</td><td className="mono">{c.log_root.slice(0, 16)}…</td><td className="mono">{c.state_root.slice(0, 16)}…</td><td>{new Date(c.created_at).toLocaleTimeString()}</td></tr>
          ))}</tbody></table></div>
        {cps.length === 0 && <div className="dim">No checkpoints yet.</div>}
      </div>

      <div className="px">
        <h3>Latest events</h3>
        <div className="scroll"><table>
          <thead><tr><th>Seq</th><th>Type</th><th>Payload</th><th /></tr></thead>
          <tbody>{events.map((e) => (
            <tr key={e.seq}>
              <td>{e.seq}</td><td><span className="tag">{e.type}</span></td>
              <td className="mono">{e.payload.slice(0, 110)}…</td>
              <td><button className="ghost sm" onClick={() => api('GET', `/audit/proofs/inclusion?seq=${e.seq}`).then(setProof)}>proof</button></td>
            </tr>
          ))}</tbody></table></div>
        {proof && (
          <details open><summary>Inclusion proof for #{proof.seq}</summary>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(proof, null, 2)}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
