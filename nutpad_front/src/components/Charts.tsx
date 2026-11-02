import { SUPPLY, spotPriceNano } from '../lib/curve';
import { fmt } from '../lib/format';

const W = 640, H = 280, PL = 52, PR = 16, PT = 24, PB = 32;

export interface TradePoint { seq: number; supply_after: string; side: string; created_at?: string; gross_sats?: string }
export interface VaultPoint { amount: string; locked_at?: string | null }

const px = (n: bigint) => Number(n) / 1e9;
const price = (supply: string | bigint) => px(spotPriceNano(BigInt(supply)));
const label = (p: number) => (p >= 0.1 ? p.toFixed(3) : p.toFixed(4));
const START = 0.001;

/** What we can honestly mark: the launch buy is the creator's; locks are public. Later trades are anonymous. */
export interface Flag { kind: 'DEV BUY' | 'LOCK'; text: string; color: string; seq: number }
export function flagsFor(trades: TradePoint[], vaults: VaultPoint[]): Flag[] {
  const sorted = [...trades].sort((a, b) => a.seq - b.seq);
  const out: Flag[] = [];
  if (sorted.length) out.push({ kind: 'DEV BUY', text: 'DEV BUY', color: '#4fd9ff', seq: sorted[0].seq });
  for (const v of vaults) {
    if (!v.locked_at) continue;
    const t = Date.parse(v.locked_at);
    let seq = sorted[0]?.seq ?? 0;
    for (const tr of sorted) if (tr.created_at && Date.parse(tr.created_at) <= t) seq = tr.seq;
    out.push({ kind: 'LOCK', text: `LOCK ${fmt(v.amount)}`, color: '#ffb627', seq });
  }
  return out;
}

function FlagMark({ x, y, f, stack, plotRight }: { x: number; y: number; f: Flag; stack: number; plotRight: number }) {
  const w = f.text.length * 6.6 + 10;
  const right = x + w > plotRight;
  const fx = right ? x - w : x;
  const fy = Math.max(PT - 14, y - 22 - stack * 16);
  return (
    <g>
      <line x1={x} x2={x} y1={fy + 13} y2={y} stroke={f.color} strokeDasharray="2 3" />
      <rect x={fx} y={fy} width={w} height="13" fill="#0a0820" stroke={f.color} />
      <text x={fx + 5} y={fy + 10} fill={f.color} fontSize="10" fontFamily="JetBrains Mono, monospace" fontWeight="700">{f.text}</text>
    </g>
  );
}

/** Price after every signed trade, starting from the curve's opening price. */
export function PriceChart({ trades, vaults = [] }: { trades: TradePoint[]; vaults?: VaultPoint[] }) {
  const pts = [...trades].sort((a, b) => a.seq - b.seq);
  const series = [{ seq: 0, p: price(0n), side: 'START' }, ...pts.map((t) => ({ seq: t.seq, p: price(t.supply_after), side: t.side }))];
  const prices = series.map((s) => s.p);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = (hi - lo || lo) * 0.18;
  const min = Math.max(0, lo - pad), max = hi + pad;
  const x = (i: number) => PL + (series.length === 1 ? 0 : (i / (series.length - 1)) * (W - PL - PR));
  const y = (p: number) => H - PB - ((p - min) / (max - min || 1)) * (H - PT - PB);

  let line = `M ${x(0)} ${y(series[0].p)}`;
  for (let i = 1; i < series.length; i++) line += ` H ${x(i)} V ${y(series[i].p)}`;
  const area = `${line} V ${H - PB} H ${x(0)} Z`;
  const last = series[series.length - 1];
  const up = last.p >= series[0].p;
  const col = up ? '#3ddc84' : '#ff7088';
  const ticks = [0, 0.33, 0.66, 1].map((f) => min + (max - min) * f);
  const flags = flagsFor(trades, vaults);
  const stackAt = new Map<number, number>();

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price history">
      <defs>
        <linearGradient id="pfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={col} stopOpacity="0.35" />
          <stop offset="1" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="#34347a" strokeDasharray="4 5" />
          <text x={PL - 8} y={y(t) + 4} fill="#8d8dc4" fontSize="11" fontFamily="monospace" textAnchor="end">{label(t)}</text>
        </g>
      ))}
      <path d={area} fill="url(#pfill)" />
      <path d={line} fill="none" stroke={col} strokeWidth="3" shapeRendering="crispEdges" />
      {series.slice(1).map((s, i) => (
        <rect key={s.seq} x={x(i + 1) - 3} y={y(s.p) - 3} width="6" height="6" fill={s.side === 'BUY' ? '#3ddc84' : '#ff7088'} />
      ))}
      <rect x={x(series.length - 1) - 5} y={y(last.p) - 5} width="10" height="10" fill="#ffb627" />
      {flags.map((f, k) => {
        const idx = Math.max(0, series.findIndex((s) => s.seq === f.seq));
        const st = stackAt.get(idx) ?? 0; stackAt.set(idx, st + 1);
        return <FlagMark key={k} x={x(idx)} y={y(series[idx].p)} f={f} stack={st} plotRight={W - PR} />;
      })}
      <text x={PL} y={H - 10} fill="#8d8dc4" fontSize="11" fontFamily="monospace">start</text>
      <text x={W - PR} y={H - 10} fill="#8d8dc4" fontSize="11" fontFamily="monospace" textAnchor="end">trade #{last.seq || 0}</text>
    </svg>
  );
}

// ───────────────────────────────────────────────────────── candlesticks
export type Frame = '1T' | '1M' | '5M' | '15M' | '1H';
export const FRAMES: [Frame, string][] = [['1T', 'Per trade'], ['1M', '1m'], ['5M', '5m'], ['15M', '15m'], ['1H', '1h']];
const FRAME_MS: Record<Exclude<Frame, '1T'>, number> = { '1M': 60_000, '5M': 300_000, '15M': 900_000, '1H': 3_600_000 };

interface Candle { o: number; h: number; l: number; c: number; v: number; t0: number; t1: number; seqs: number[] }

function buildCandles(trades: TradePoint[], frame: Frame): Candle[] {
  const sorted = [...trades].sort((a, b) => a.seq - b.seq);
  const out: Candle[] = [];
  let prev = START;
  const ts = (t: TradePoint) => (t.created_at ? Date.parse(t.created_at) : 0);
  if (frame === '1T') {
    for (const t of sorted) {
      const c = price(t.supply_after);
      out.push({ o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c, v: Number(t.gross_sats ?? 0), t0: ts(t), t1: ts(t), seqs: [t.seq] });
      prev = c;
    }
    return out;
  }
  const ms = FRAME_MS[frame];
  let cur: Candle | null = null; let key = -1;
  for (const t of sorted) {
    const k = Math.floor(ts(t) / ms);
    const c = price(t.supply_after);
    if (!cur || k !== key) {
      if (cur) out.push(cur);
      cur = { o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c, v: 0, t0: ts(t), t1: ts(t), seqs: [] };
      key = k;
    }
    cur.h = Math.max(cur.h, c); cur.l = Math.min(cur.l, c); cur.c = c; cur.t1 = ts(t);
    cur.v += Number(t.gross_sats ?? 0); cur.seqs.push(t.seq);
    prev = c;
  }
  if (cur) out.push(cur);
  return out;
}

const hhmm = (ms: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

export function CandleChart({ trades, vaults = [], frame }: { trades: TradePoint[]; vaults?: VaultPoint[]; frame: Frame }) {
  const candles = buildCandles(trades, frame);
  if (candles.length === 0) return <div className="dim">No trades yet</div>;
  const VH = 46;                                  // volume strip height
  const bottom = H - PB - VH - 6;
  const lo = Math.min(...candles.map((c) => c.l)), hi = Math.max(...candles.map((c) => c.h));
  const pad = (hi - lo || lo) * 0.2;
  const min = Math.max(0, lo - pad), max = hi + pad;
  const y = (p: number) => bottom - ((p - min) / (max - min || 1)) * (bottom - PT);
  const n = candles.length;
  const slot = (W - PL - PR) / Math.max(n, 1);
  const cw = Math.max(4, Math.min(26, slot * 0.62));
  const cx = (i: number) => PL + slot * (i + 0.5);
  const vmax = Math.max(...candles.map((c) => c.v), 1);
  const ticks = [0, 0.33, 0.66, 1].map((f) => min + (max - min) * f);

  // flags: find the candle that contains the event
  const flags = flagsFor(trades, vaults);
  const stackAt = new Map<number, number>();
  const placed = flags.map((f) => {
    let idx = candles.findIndex((c) => c.seqs.includes(f.seq));
    if (idx < 0) idx = 0;
    const st = stackAt.get(idx) ?? 0; stackAt.set(idx, st + 1);
    return { f, idx, st };
  });

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Candlestick chart">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="#34347a" strokeDasharray="4 5" />
          <text x={PL - 8} y={y(t) + 4} fill="#8d8dc4" fontSize="11" fontFamily="monospace" textAnchor="end">{label(t)}</text>
        </g>
      ))}
      {candles.map((c, i) => {
        const up = c.c >= c.o;
        const col = up ? '#3ddc84' : '#ff7088';
        const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
        const vh = Math.max(2, (c.v / vmax) * VH);
        return (
          <g key={i}>
            <title>{`${hhmm(c.t0)}  O ${label(c.o)}  H ${label(c.h)}  L ${label(c.l)}  C ${label(c.c)}  vol ${fmt(c.v)} sats`}</title>
            <rect x={cx(i) - cw / 2} y={H - PB - vh} width={cw} height={vh} fill={col} opacity="0.35" />
            <line x1={cx(i)} x2={cx(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="2" />
            <rect x={cx(i) - cw / 2} y={top} width={cw} height={Math.max(3, bot - top)} fill={up ? col : '#0a0820'} stroke={col} strokeWidth="2" />
          </g>
        );
      })}
      {placed.map(({ f, idx, st }, k) => (
        <FlagMark key={k} x={cx(idx)} y={y(candles[idx].h)} f={f} stack={st} plotRight={W - PR} />
      ))}
      <line x1={PL} x2={W - PR} y1={H - PB} y2={H - PB} stroke="#34347a" />
      <text x={PL} y={H - 10} fill="#8d8dc4" fontSize="11" fontFamily="monospace">{frame === '1T' ? 'first trade' : hhmm(candles[0].t0)}</text>
      <text x={W - PR} y={H - 10} fill="#8d8dc4" fontSize="11" fontFamily="monospace" textAnchor="end">{frame === '1T' ? `trade #${candles[n - 1].seqs[0]}` : hhmm(candles[n - 1].t1)}</text>
      <text x={PL} y={H - PB - VH - 12} fill="#6d6dad" fontSize="9" fontFamily="monospace">VOLUME</text>
    </svg>
  );
}

/** The linear bonding curve: sold supply shaded, current point highlighted. */
export function CurveChart({ supply }: { supply: bigint }) {
  const maxP = px(spotPriceNano(SUPPLY));
  const x = (q: number) => PL + (q / Number(SUPPLY)) * (W - PL - PR);
  const y = (p: number) => H - PB - (p / maxP) * (H - PT - PB);
  const q = Number(supply);
  const cur = px(spotPriceNano(supply));
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bonding curve">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PL} x2={W - PR} y1={y(maxP * f)} y2={y(maxP * f)} stroke="#34347a" strokeDasharray="4 5" />
          <text x={PL - 8} y={y(maxP * f) + 4} fill="#8d8dc4" fontSize="11" fontFamily="monospace" textAnchor="end">{label(maxP * f)}</text>
        </g>
      ))}
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={x(Number(SUPPLY) * f)} x2={x(Number(SUPPLY) * f)} y1={PT} y2={H - PB} stroke="#34347a" strokeDasharray="2 6" />)}
      <polygon points={`${x(0)},${y(0)} ${x(0)},${y(0.001)} ${x(q)},${y(cur)} ${x(q)},${y(0)}`} fill="#3ddc8440" />
      <line x1={x(0)} y1={y(0.001)} x2={x(Number(SUPPLY))} y2={y(maxP)} stroke="#4fd9ff" strokeWidth="3" />
      <line x1={x(q)} x2={x(q)} y1={y(0)} y2={y(cur)} stroke="#ffb627" strokeDasharray="4 4" />
      <rect x={x(q) - 5} y={y(cur) - 5} width="10" height="10" fill="#ffb627" />
      <text x={Math.min(x(q) + 12, W - 120)} y={Math.max(y(cur) - 12, 16)} fill="#ffb627" fontSize="12" fontFamily="monospace">now {label(cur)}</text>
      <text x={PL} y={H - 10} fill="#8d8dc4" fontSize="11" fontFamily="monospace">0</text>
      <text x={W - PR} y={H - 10} fill="#8d8dc4" fontSize="11" fontFamily="monospace" textAnchor="end">21,000,000 units</text>
    </svg>
  );
}
