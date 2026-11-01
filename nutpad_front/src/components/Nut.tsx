import { useEffect, useRef, useSyncExternalStore } from 'react';
import { H, W, drawNut, drawProp, type NutKey, type PropKey } from '../lib/nuts';

/* One shared 300 ms clock for every animated nut (instead of a timer + re-render per nut). */
let tick = 0;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribe(cb: () => void) {
  subs.add(cb);
  if (!timer) timer = setInterval(() => { tick++; subs.forEach((s) => s()); }, 300);
  return () => {
    subs.delete(cb);
    if (!subs.size && timer) { clearInterval(timer); timer = null; }
  };
}
const useTick = (on: boolean) => useSyncExternalStore(on ? subscribe : () => () => {}, () => (on ? tick : 0));

/* Pre-rendered sprites: drawing a nut once per (nut, scale, frame, mouth) and blitting afterwards. */
const sprites = new Map<string, HTMLCanvasElement>();
function sprite(k: NutKey, scale: number, frame: number, talk: boolean) {
  const id = `${k}:${scale}:${frame}:${talk}`;
  let c = sprites.get(id);
  if (!c) {
    c = document.createElement('canvas');
    drawNut(c, k, scale, frame, talk);
    sprites.set(id, c);
  }
  return c;
}
const urls = new Map<string, string>();
/** A cached data-URL of a still nut, for lists and cards (no canvas per item). */
export function nutUrl(k: NutKey, scale = 2): string {
  const id = `${k}:${scale}`;
  let u = urls.get(id);
  if (!u) { u = sprite(k, scale, 0, false).toDataURL(); urls.set(id, u); }
  return u;
}

export function NutImg({ k, size = 40, className = '', title }: { k: NutKey; size?: number; className?: string; title?: string }) {
  return <img src={nutUrl(k, 2)} width={size} height={size} alt="" title={title} className={`pixelated ${className}`} draggable={false} />;
}

/** Animated pixel nut. `talking` opens the mouth and makes it hop. */
export function Nut({ k, scale = 4, talking = false, bob = true, anim = true, className = '' }: { k: NutKey; scale?: number; talking?: boolean; bob?: boolean; anim?: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const t = useTick(anim);
  const frame = t % 2;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const c = cv.getContext('2d')!;
    c.clearRect(0, 0, cv.width, cv.height);
    c.drawImage(sprite(k, scale, frame, talking && t % 2 === 0), 0, 0);
  }, [k, scale, frame, talking, t]);
  return <canvas ref={ref} width={W * scale} height={H * scale} aria-hidden="true" className={`pixelated ${anim ? (talking ? 'nut-hop' : bob ? 'nut-bob' : '') : ''} ${className}`} />;
}

export function Prop({ name, scale = 4, className = '' }: { name: PropKey; scale?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) drawProp(ref.current, name, scale); }, [name, scale]);
  return <canvas ref={ref} aria-hidden="true" className={`pixelated ${className}`} />;
}

/** A nut with a speech bubble, used as a friendly page header. */
export function NutSays({ k, text, scale = 3, prop }: { k: NutKey; text: string; scale?: number; prop?: PropKey }) {
  return (
    <div className="nut-says">
      <div className="nut-says-art">
        <Nut k={k} scale={scale} />
        {prop && <Prop name={prop} scale={3} className="nut-says-prop" />}
      </div>
      <div className="speech-lite">{text}</div>
    </div>
  );
}

/** Deterministic mascot for an asset (so every token card has its own nut). */
export const NUT_KEYS: NutKey[] = ['cashu', 'walt', 'pista', 'al', 'pea', 'hazel'];
export const nutForId = (id: string): NutKey => NUT_KEYS[parseInt(id.slice(0, 4), 16) % NUT_KEYS.length]!;
