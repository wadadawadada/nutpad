import { SUPPLY, spotPriceNano } from '../lib/curve';

const W = 640, H = 280, PL = 52, PR = 16, PT = 20, PB = 32;

export interface TradePoint { seq: number; supply_after: string; side: string }

const px = (n: bigint) => Number(n) / 1e9;
const price = (supply: string | bigint) => px(spotPriceNano(BigInt(supply)));
const label = (p: number) => (p >= 0.1 ? p.toFixed(3) : p.toFixed(4));

/** Price after every signed trade, starting from the curve's opening price. */
export function PriceChart({ trades }: { trades: TradePoint[] }) {
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
      <text x={Math.min(x(series.length - 1) + 12, W - 90)} y={Math.max(y(last.p) - 12, 14)} fill="#ffb627" fontSize="12" fontFamily="monospace">{label(last.p)} sat</text>
      <text x={PL} y={H - 10} fill="#8d8dc4" fontSize="11" fontFamily="monospace">start</text>
      <text x={W - PR} y={H - 10} fill="#8d8dc4" fontSize="11" fontFamily="monospace" textAnchor="end">trade #{last.seq || 0}</text>
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
