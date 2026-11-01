/* Pixel nuts — reference style: body on a coarse 20×20 grid (big blocks), shades on a fine 40×40 grid. */
export const W = 40;
export const H = 40;
type Grid = (string | null)[][];
export type NutKey = 'cashu' | 'walt' | 'pista' | 'al' | 'pea' | 'hazel';

const grid = (): Grid => Array.from({ length: H }, () => Array(W).fill(null));
const set = (g: Grid, x: number, y: number, c: string | null) => { if (c && y >= 0 && y < H && x >= 0 && x < W) g[y]![x] = c; };
const ell = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => { const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry; return dx * dx + dy * dy <= 1; };

/* pal: [band1, band2, band3, main, top-light, spec, rim] */
export const NUTS: Record<NutKey, { name: string; nut: string; role: string; say: string; pal: string[] }> = {
  cashu: { name: 'CASHU', nut: 'Cashew', role: 'THE MINT', say: 'The real Cashu mint. Holds the ecash vault. Everyone must trust him a little.', pal: ['#b88d52', '#c9a063', '#d8b278', '#e2c48f', '#ecd6aa', '#f7f3da', '#cfa96f'] },
  walt: { name: 'WALT', nut: 'Walnut', role: 'BUYER AGENT', say: 'Wants things, has a budget, pays only after checking.', pal: ['#6a4426', '#7f5530', '#966a3d', '#ac8049', '#c29a62', '#e6cfa6', '#8b5f35'] },
  pista: { name: 'PISTA', nut: 'Pistachio', role: 'SELLER AGENT', say: 'Cracks a smile, lists the goods, delivers on time.', pal: ['#bba66c', '#cbb880', '#dacb98', '#e8dcb0', '#f2e9c8', '#fffbe6', '#cdb97e'] },
  al: { name: 'AL', nut: 'Almond', role: "BUYER'S CHECKER", say: "Walt's own checking agent. Tests every delivery before the money moves.", pal: ['#7b4b2b', '#925b35', '#aa7044', '#c08555', '#d39c70', '#f0d2b0', '#9d6a40'] },
  pea: { name: 'PEA', nut: 'Peanut', role: 'RELAY COURIER', say: 'Carries signed messages between agents. Reads nothing.', pal: ['#c29b55', '#d2ae68', '#dfbf7e', '#ecd093', '#f5deaa', '#fff8dc', '#d4b273'] },
  hazel: { name: 'HAZEL', nut: 'Acorn', role: 'WORKSHOP', say: 'The machine or tool behind a seller: GPU, disk, site builder, image model.', pal: ['#7a4a1b', '#935c25', '#ab7032', '#c4863f', '#d99d58', '#f0cf9c', '#a26a30'] },
};
export const NUT_ORDER: NutKey[] = ['cashu', 'walt', 'pista', 'al', 'pea', 'hazel'];

const N = 20;
const CASHEW: Record<number, [number, number]> = { 1: [5, 11], 2: [4, 12], 3: [3, 12], 4: [3, 12], 5: [3, 11], 6: [3, 11], 7: [3, 10], 8: [3, 10], 9: [3, 10], 10: [3, 11], 11: [3, 11], 12: [3, 14], 13: [4, 16], 14: [4, 16], 15: [5, 16], 16: [5, 15], 17: [6, 14] };
const pOval = (x: number, y: number) => ell(x, y, 10, 11, 5.8, 7.7);
const pGap = (y: number) => 0.95 + Math.max(0, 9 - y) * 0.22;
/* the green kernel only shows in the upper part of the gap and tapers off; the lower shell stays closed */
const pKern = (x: number, y: number) => pOval(x, y) && y <= 10 && Math.abs(x + 0.5 - 10) < Math.min(pGap(y), (11.5 - y) * 0.75);
const MASK: Record<NutKey, (x: number, y: number) => boolean> = {
  cashu: (x, y) => { const r = CASHEW[y]; return !!r && x >= r[0] && x <= r[1]; },
  walt: (x, y) => ell(x, y, 7.5, 11, 5.4, 6.3) || ell(x, y, 12.5, 11, 5.4, 6.3),
  pista: (x, y) => pOval(x, y),
  al: (x, y) => { const dy = y + 0.5 - 11.5; if (y < 2 || y > 19) return false; const hw = dy < 0 ? 5.4 * Math.pow(Math.max(0, 1 - Math.pow(-dy / 9.6, 1.4)), 0.62) : 5.4 * Math.sqrt(Math.max(0, 1 - (dy / 7.8) ** 2)); return Math.abs(x + 0.5 - 10) <= hw; },
  pea: (x, y) => ell(x, y, 7, 6.2, 4.2, 4.4) || ell(x, y, 12.6, 13.4, 5, 5.2) || ell(x, y, 9.8, 9.8, 3.2, 3.2),
  hazel: (x, y) => (ell(x, y, 10, 14.5, 5.4, 5) && y >= 10) || (ell(x, y, 10, 10.4, 6.9, 4) && y <= 11) || (x === 9 && y >= 4 && y <= 6),
};
const GLASS: Record<NutKey, { x0?: number; cx?: number; lw: number; gap: number; y: number }> = {
  cashu: { x0: 6, lw: 9, gap: 3, y: 13 }, walt: { lw: 11, gap: 3, y: 16 }, pista: { lw: 9, gap: 3, y: 22 }, al: { lw: 9, gap: 2, y: 19 }, pea: { lw: 9, gap: 3, y: 22, cx: 25 }, hazel: { lw: 10, gap: 3, y: 25 },
};

function body(key: NutKey) {
  const [b1, b2, b3, M, T, SP, R] = NUTS[key].pal as [string, string, string, string, string, string, string];
  const g = grid(), m = MASK[key];
  let minx = 99, maxx = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (m(x, y)) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); }
  const c20: (string | null)[][] = Array.from({ length: N }, () => Array(N).fill(null));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (m(x, y)) {
    const k = x - minx;
    let c = k === 0 ? b1 : k === 1 ? b2 : k === 2 ? b3 : M;
    const top = !m(x, y - 1), bot = !m(x, y + 1);
    if (k >= 2 && top) c = T;
    if (k === 1 && top) c = b3;
    if (bot && k >= 1) c = R;
    c20[y]![x] = c;
  }
  const sp = (x: number, y: number, c: string) => { if (c20[y] && c20[y]![x]) c20[y]![x] = c; };
  if (key === 'cashu') { sp(13, 13, SP); sp(14, 13, SP); sp(11, 10, T); sp(11, 11, T); sp(11, 5, R); sp(11, 6, R); }
  if (key === 'walt') { for (let y = 5; y < 17; y++) { sp(9, y, b1); sp(10, y, b1); } for (const [x, y] of [[4, 8], [15, 7], [3, 13], [16, 14]] as const) sp(x, y, b3); sp(5, 6, T); sp(6, 6, T); sp(13, 6, T); }
  if (key === 'pista') {
    const GREEN = ['#4f8a1f', '#74b030', '#9ad446', '#b9ea6c'];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (pKern(x, y)) c20[y]![x] = GREEN[Math.min(3, Math.max(0, x - 8))]!;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (c20[y]![x] && !pKern(x, y) && ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => pKern(x + dx, y + dy))) c20[y]![x] = b1;
    for (const y of [4, 5]) sp(8, y, '#e6ffb0');
    for (const y of [11, 13, 14, 16]) { sp(9, y, b1); sp(10, y, b2); }
    for (let y = 3; y < 18; y += 3) { sp(5, y + 1, b2); sp(14, y, b3); }
  }
  if (key === 'al') { sp(minx + 1, 6, b1); sp(minx + 1, 12, b1); sp(maxx - 1, 9, b2); sp(maxx - 1, 14, b2); sp(8, 7, T); sp(8, 8, T); }
  if (key === 'pea') { for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (c20[y]![x] && (x + 2 * y) % 4 === 0 && x - minx >= 2) c20[y]![x] = b2; sp(15, 15, SP); sp(16, 15, SP); sp(6, 3, T); }
  if (key === 'hazel') {
    const cb = '#8a5a2e', cd = '#5c3a1a', cl = '#b4814a';
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (c20[y]![x] && y <= 11 && ell(x, y, 10, 10.4, 6.9, 4)) c20[y]![x] = (x + y) % 2 === 0 ? (y < 10 ? cl : cb) : (y < 10 ? cb : cd);
    sp(9, 4, cd); sp(9, 5, cd); sp(9, 6, cd); sp(13, 15, SP);
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (c20[y]![x]) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) g[y * 2 + dy]![x * 2 + dx] = c20[y]![x]!;
  return { g, minx: minx * 2, maxx: maxx * 2 + 1 };
}

/* ── sunglasses: the cashew keeps the original Cashu shades, every other nut has its own pair ── */
function lensCells(x: number, y: number, w: number, insets: (number | [number, number])[]) {
  const cells: [number, number][] = [];
  insets.forEach((ins, r) => { const l = Array.isArray(ins) ? ins[0] : ins, rr = Array.isArray(ins) ? ins[1] : ins; for (let i = l; i < w - rr; i++) cells.push([x + i, y + r]); });
  return cells;
}
function paintLens(g: Grid, cells: [number, number][], fillFn: (x: number, y: number) => string, border: string | null) {
  const S = new Set(cells.map(([x, y]) => x + ',' + y));
  for (const [x, y] of cells) set(g, x, y, fillFn(x, y));
  if (border) for (const [x, y] of cells) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (!S.has((x + dx) + ',' + (y + dy))) set(g, x + dx, y + dy, border);
}
type Shade = (g: Grid, x0: number, y: number, lw: number, gap: number, f: number) => void;
const SHADES: Partial<Record<NutKey, Shade>> = {
  walt(g, x0, y, lw, gap, f) {
    const ins: [number, number][] = [[0, 0], [0, 0], [0, 1], [1, 2], [2, 3], [4, 5]];
    for (const x of [x0, x0 + lw + gap]) {
      paintLens(g, lensCells(x, y, lw, ins), (_px, py) => (py - y < 2 ? '#1c6f7c' : '#36b5ba'), '#e8b83a');
      set(g, x + 2 + f, y + 1, '#ffffff'); set(g, x + 3 + f, y + 1, '#d8fbff'); set(g, x + 2, y + 2, '#bff3f5');
    }
    for (let i = lw + 1; i < lw + gap + 1; i++) { set(g, x0 + i, y, '#e8b83a'); set(g, x0 + i, y + 1, '#e8b83a'); }
    set(g, x0 - 2, y, '#e8b83a'); set(g, x0 + 2 * lw + gap + 1, y, '#e8b83a');
  },
  pista(g, x0, y, lw, gap, f) {
    const R = [[1, 2, 4, 5], [0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5], [2, 3, 4], [3]];
    for (const x of [x0 + Math.floor((lw - 7) / 2), x0 + lw + gap + Math.floor((lw - 7) / 2)]) {
      const cells: [number, number][] = []; R.forEach((row, r) => row.forEach((i) => cells.push([x + i, y + r])));
      paintLens(g, cells, (_px, py) => (py - y < 2 ? '#ff5aa8' : '#ff2f8f'), '#6b0f3b');
      set(g, x + 1, y + 1, '#ffd6ea'); set(g, x + 2 + f, y + 1, '#ffffff');
    }
    set(g, x0 + lw + Math.floor(gap / 2), y + 1, '#6b0f3b'); set(g, x0 + lw + Math.floor(gap / 2) + 1, y + 1, '#6b0f3b');
  },
  al(g, x0, y, lw, gap, f) {
    const ins = [2, 0, 0, 1];
    for (const x of [x0, x0 + lw + gap]) {
      paintLens(g, lensCells(x, y, lw, ins), () => '#0a0a0a', null);
      set(g, x + 2 + f, y + 1, '#7dff9a'); set(g, x + 3 + f, y + 1, '#2f8f48');
    }
    for (let i = lw; i < lw + gap; i++) set(g, x0 + i, y + 1, '#0a0a0a');
    set(g, x0 - 1, y + 1, '#0a0a0a'); set(g, x0 - 2, y, '#0a0a0a'); set(g, x0 + 2 * lw + gap, y + 1, '#0a0a0a'); set(g, x0 + 2 * lw + gap + 1, y, '#0a0a0a');
  },
  pea(g, x0, y, lw, gap, f) {
    const ins = [0, 0, 0, 0, 0];
    paintLens(g, lensCells(x0, y, lw, ins), () => '#e63946', '#f4f4f4');
    paintLens(g, lensCells(x0 + lw + gap, y, lw, ins), () => '#2fd0ee', '#f4f4f4');
    set(g, x0 + 1 + f, y + 1, '#ffb3b8'); set(g, x0 + lw + gap + 1 + f, y + 1, '#c8f6ff');
    for (let i = lw + 1; i < lw + gap + 1; i++) { set(g, x0 + i, y + 1, '#f4f4f4'); set(g, x0 + i, y + 2, '#f4f4f4'); }
    set(g, x0 - 2, y, '#f4f4f4'); set(g, x0 + 2 * lw + gap + 1, y, '#f4f4f4');
  },
  hazel(g, x0, y, lw, gap, f) {
    const K = '#0a0a0a', total = 2 * lw + gap;
    for (let i = -1; i <= total; i++) { set(g, x0 + i, y, K); set(g, x0 + i, y + 1, K); }
    for (const x of [x0, x0 + lw + gap]) paintLens(g, lensCells(x, y + 2, lw, [[0, 0], [0, 0], [2, 2]]), (px, py) => ((px - x + (py - y)) % 5 === f ? '#8bb8ff' : '#2a63d6'), K);
    for (let i = lw; i < lw + gap; i++) set(g, x0 + i, y + 2, K);
    set(g, x0 - 2, y, K); set(g, x0 + total + 1, y, K);
  },
};

function glasses(g: Grid, key: NutKey, frame: number, talk: boolean, bx: { minx: number; maxx: number }) {
  const cfg = GLASS[key], lw = cfg.lw, gap = cfg.gap, y = cfg.y, K = '#0a0a0a', f = frame % 2;
  const total = 2 * lw + gap, x0 = cfg.x0 !== undefined ? cfg.x0 : Math.round((cfg.cx !== undefined ? cfg.cx : (bx.minx + bx.maxx + 1) / 2) - total / 2);
  const mouth = (dy: number) => { const mx = x0 + lw + Math.floor(gap / 2) - 1; for (let i = 0; i < 4; i++) { set(g, mx + i, y + dy, '#4a2410'); set(g, mx + i, y + dy + 1, '#4a2410'); } };
  const shade = SHADES[key];
  if (shade) { shade(g, x0, y, lw, gap, f); if (talk) mouth(7); return; }
  const lens = (x: number) => { for (let r = 0; r < 4; r++) { const ins = r === 3 ? 3 : r === 2 ? 1 : 0; for (let i = ins; i < lw - ins; i++) set(g, x + i, y + r, K); } };
  lens(x0); lens(x0 + lw + gap);
  for (let i = lw - 1; i < lw + gap + 1; i++) { set(g, x0 + i, y, K); set(g, x0 + i, y + 1, K); }
  set(g, x0 - 1, y, K); set(g, x0 + total, y, K);
  for (const bxx of [x0, x0 + lw + gap]) for (const [dx, dy] of [[2, 1], [4, 1], [3, 2], [5, 2]] as const) if (dx + 1 < lw) set(g, bxx + dx, y + dy, (dx + dy + f) % 2 === 0 ? '#ffffff' : '#9aa3b2');
  if (talk) mouth(6);
}

const cache = new Map<string, Grid>();
export function sprite(key: NutKey, frame = 0, talk = false): Grid {
  const id = `${key}:${frame % 2}:${talk}`;
  let g = cache.get(id);
  if (!g) { const b = body(key); glasses(b.g, key, frame, talk, b); g = b.g; cache.set(id, g); }
  return g;
}
export function drawNut(cv: HTMLCanvasElement, key: NutKey, scale: number, frame = 0, talk = false) {
  const g = sprite(key, frame, talk);
  cv.width = W * scale; cv.height = H * scale;
  const c = cv.getContext('2d')!;
  c.clearRect(0, 0, cv.width, cv.height);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const col = g[y]![x]; if (col) { c.fillStyle = col; c.fillRect(x * scale, y * scale, scale, scale); } }
}

/* ── props ── */
const P: Record<string, string> = { y: '#ffd23a', o: '#e89a1c', w: '#ffffff', k: '#17120d', g: '#35c45a', s: '#8a8a99', u: '#6b4423', U: '#8d5e32', b: '#78c8ff', B: '#2d6fb0', n: '#9b6a2f', c: '#d8d8e0' };
export type PropKey = 'coin' | 'lock' | 'envelope' | 'check' | 'magnifier' | 'box';
export const PROPS: Record<PropKey, string[]> = {
  coin: ['..yyyyyy..', '.yyooooyy.', 'yyoyyyyoyy', 'yoyyooyyoy', 'yoyyooyyoy', 'yyoyyyyoyy', '.yyooooyy.', '..yyyyyy..'],
  lock: ['..ssss..', '.s....s.', '.s....s.', 'yyyyyyyy', 'yyyookyy', 'yyyookyy', 'yyyyyyyy'],
  envelope: ['wwwwwwwwwwww', 'wcwwwwwwwwcw', 'wwcwwwwwwcww', 'wwwcwwwwcwww', 'wwwwcwwcwwww', 'wwwwwccwwwww', 'wwwwwwwwwwww'],
  check: ['.........gg', '........ggg', '.......ggg.', 'gg....ggg..', 'ggg..ggg...', '.gggggg....', '..gggg.....', '...gg......'],
  magnifier: ['..bbbbb...', '.bwwbbbb..', 'bwbbbbbbb.', 'bwbbbbbbb.', 'bbbbbbbbb.', '.bbbbbbb..', '..bbbbb...', '......nn..', '.......nn.', '........nn'],
  box: ['uuuuuuuuuu', 'uUUUUyyUUu', 'uUUUUyyUUu', 'uUUUUyyUUu', 'uUUUUyyUUu', 'uuuuuuuuuu'],
};
export function drawProp(cv: HTMLCanvasElement, name: PropKey, scale: number) {
  const rows = PROPS[name];
  cv.width = rows[0]!.length * scale; cv.height = rows.length * scale;
  const c = cv.getContext('2d')!;
  rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch !== '.') { c.fillStyle = P[ch]!; c.fillRect(i * scale, j * scale, scale, scale); } }));
}

/** Where an arm leaves the body: a row below the shades, at the outermost body cell on the chosen side (40×40 sprite cells). */
export function armAnchor(key: NutKey, dir: number): { sy: number; ex: number } {
  const g = sprite(key, 0, false);
  let bottom = 0;
  for (let y = 0; y < H; y++) if (g[y]!.some((c) => c)) bottom = y;
  const sy = Math.min(GLASS[key].y + 7, bottom - 4);
  const row = g[sy]!;
  let lo = W, hi = 0;
  for (let x = 0; x < W; x++) if (row[x]) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  return { sy, ex: dir > 0 ? hi + 1 : lo - 1 };
}
