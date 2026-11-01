import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { errMsg } from '../lib/format';
import { Nut } from './Nut';
import type { NutKey } from '../lib/nuts';

interface ToastItem { id: number; text: string; kind: 'info' | 'ok' | 'err' }
const ToastCtx = createContext<(text: string, kind?: ToastItem['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, kind: ToastItem['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'err' ? 8000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((i) => <div key={i.id} className={`toast ${i.kind}`}>{i.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/** Run an async action with a busy flag and toast on error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'ok');
      return r;
    } catch (e) {
      toast(errMsg(e), 'err');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { busy, run };
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="px modal hot">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>{title}</h2>
          <button className="ghost sm" onClick={onClose}>X</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Stat({ k, v }: { k: string; v: ReactNode }) {
  return <div className="stat"><span className="dim">{k}</span><span>{v}</span></div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><label>{label}</label>{children}</div>;
}

/* ───── celebration overlay: a nut stamps the result of a trade or launch ───── */
export interface Celebration { stamp: string; text: string; nut: NutKey; tone?: 'buy' | 'sell' }
const CelebrateCtx = createContext<(c: Celebration) => void>(() => {});
export const useCelebrate = () => useContext(CelebrateCtx);
const BITS = Array.from({ length: 28 }, (_, i) => ({ left: (i * 37) % 100, delay: -((i * 0.29) % 2), dur: 1.6 + ((i * 7) % 10) / 10, color: ['#d8ff68', '#ff4fb8', '#74d6ff', '#ffd23a', '#ffffff'][i % 5]! }));

export function CelebrateProvider({ children }: { children: ReactNode }) {
  const [c, setC] = useState<Celebration | null>(null);
  const show = useCallback((x: Celebration) => { setC(x); setTimeout(() => setC((cur) => (cur === x ? null : cur)), 3200); }, []);
  return (
    <CelebrateCtx.Provider value={show}>
      {children}
      {c && (
        <div className="celebrate" onClick={() => setC(null)} role="status">
          {BITS.map((b, i) => <i key={i} className="confetti" style={{ left: `${b.left}%`, animationDelay: `${b.delay}s`, animationDuration: `${b.dur}s`, background: b.color }} />)}
          <div className={`celebrate-card ${c.tone ?? 'buy'}`}>
            <div className="stamp">{c.stamp}</div>
            <div><Nut k={c.nut} scale={6} talking /></div>
            <p>{c.text}</p>
            <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>click to close</div>
          </div>
        </div>
      )}
    </CelebrateCtx.Provider>
  );
}
