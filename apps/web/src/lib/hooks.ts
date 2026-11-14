import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

/** Зарежда данни; reload() след промяна. */
export function useLoad<T>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    api.get<T>(url).then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, ...deps]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []), setData };
}

/** SSE: пълен снимък при всяка промяна; браузърът сам се свързва отново. */
export function useStream<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [online, setOnline] = useState(false);
  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener('snapshot', (e) => { setData(JSON.parse((e as MessageEvent).data)); setOnline(true); });
    es.onerror = () => setOnline(false);
    return () => es.close();
  }, [url]);
  return { data, online };
}

/** Часовник, който се обновява на всеки `ms`. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** Връща към началото след бездействие (киоск). */
export function useIdle(ms: number, onIdle: () => void, active = true) {
  const cb = useRef(onIdle);
  cb.current = onIdle;
  useEffect(() => {
    if (!active) return;
    let t = setTimeout(() => cb.current(), ms);
    const reset = () => { clearTimeout(t); t = setTimeout(() => cb.current(), ms); };
    const evs = ['pointerdown', 'keydown', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, reset));
    return () => { clearTimeout(t); evs.forEach((e) => window.removeEventListener(e, reset)); };
  }, [ms, active]);
}

/** Кратък звук при нова поръчка (без файлове). */
export function beep() {
  try {
    const ctx = new AudioContext();
    [0, 0.25].forEach((at) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.25, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.2);
      o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 0.22);
    });
  } catch { /* без звук */ }
}

export function safeStorage(kind: 'local' | 'session') {
  const s = () => (kind === 'local' ? window.localStorage : window.sessionStorage);
  return {
    get(key: string) { try { return s().getItem(key); } catch { return null; } },
    set(key: string, v: string) { try { s().setItem(key, v); } catch { /* няма място или е забранено */ } },
    del(key: string) { try { s().removeItem(key); } catch { /* */ } },
  };
}
