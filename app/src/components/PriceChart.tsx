import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Point, type Range, RANGE_OPTIONS, useCandles, useDetailCandles } from '../lib/candles';

const W = 760;
const H = 300;
const PAD = { top: 16, right: 70, bottom: 28, left: 8 };
const PLOT_W = W - PAD.left - PAD.right;
/** Narrowest zoom window, in seconds: about ten 1-minute candles. */
const MIN_SPAN = 600;

type View = { start: number; end: number };

function niceTicks(min: number, max: number, count = 5): number[] {
  const span = max - min || 1;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const mult = [1, 2, 2.5, 5, 10].find((m) => span / (step * m) <= count) ?? 10;
  const s = step * mult;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / s) * s; v <= max; v += s) ticks.push(v);
  return ticks;
}

const fmtPrice = (p: number) =>
  p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: p < 10 ? 4 : 2 });

function fmtTime(t: number, span: number) {
  const d = new Date(t * 1000);
  return span > 2 * 86_400
    ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Shrink or grow `view` by `factor` around time `anchor`, kept inside [t0, t1]. Null means fully zoomed out. */
function zoomView(view: View, factor: number, anchor: number, t0: number, t1: number): View | null {
  const span = view.end - view.start;
  const next = Math.max(MIN_SPAN, span * factor);
  if (next >= t1 - t0) return null;
  const start = anchor - (anchor - view.start) * (next / span);
  return clampView({ start, end: start + next }, t0, t1);
}

function clampView(view: View, t0: number, t1: number): View {
  const span = view.end - view.start;
  const start = Math.min(Math.max(view.start, t0), t1 - span);
  return { start, end: start + span };
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function PriceChart({ symbol, markPrice }: { symbol: string; markPrice: number | null }) {
  const [range, setRange] = useState<Range>('1D');
  const { data: history, error } = useCandles(symbol, range);

  // Append on-chain mark prices observed since page load so the line reaches "now".
  const [live, setLive] = useState<Point[]>([]);
  useEffect(() => setLive([]), [symbol]);
  useEffect(() => {
    if (markPrice == null) return;
    setLive((pts) => [...pts.slice(-300), { t: Math.floor(Date.now() / 1000), p: markPrice }]);
  }, [markPrice]);

  const all = useMemo(() => {
    const base = history ?? [];
    const lastT = base.length ? base[base.length - 1].t : 0;
    return [...base, ...live.filter((pt) => pt.t > lastT)];
  }, [history, live]);

  // Zoom window; null shows the whole range. Finer candles are fetched once it settles.
  const [view, setView] = useState<View | null>(null);
  useEffect(() => setView(null), [symbol, range]);
  const { data: detail } = useDetailCandles(symbol, range, useDebounced(view, 300));

  const points = useMemo(() => {
    if (!detail?.points.length) return all;
    return [...all.filter((pt) => pt.t < detail.start), ...detail.points, ...all.filter((pt) => pt.t > detail.end)];
  }, [all, detail]);

  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; view: View } | null>(null);
  // A click that didn't pan opens the chart full view.
  const moved = useRef(false);

  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setExpanded(false);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded]);

  const t0 = points.length ? points[0].t : 0;
  const t1 = points.length ? points[points.length - 1].t : 0;
  const vs = view?.start ?? t0;
  const ve = view?.end ?? t1;
  const timeAt = (clientX: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = ((clientX - rect.left) / rect.width) * W;
    return vs + ((sx - PAD.left) / PLOT_W) * (ve - vs);
  };

  // Wheel zoom needs a non-passive listener so it can stop the page from scrolling.
  const zoomRef = useRef<(e: WheelEvent) => void>(() => {});
  zoomRef.current = (e: WheelEvent) => {
    if (t1 - t0 <= MIN_SPAN) return;
    e.preventDefault();
    setHover(null);
    setView(zoomView({ start: vs, end: ve }, Math.exp(e.deltaY * 0.002), timeAt(e.clientX), t0, t1));
  };
  const hasChart = points.length >= 2;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => zoomRef.current(e);
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [hasChart, expanded]);

  const zoomBy = (factor: number) => setView(zoomView({ start: vs, end: ve }, factor, (vs + ve) / 2, t0, t1));

  const header = (
    <div className="card-head">
      <h2 className="card-title">Price</h2>
      <div className="chart-tools">
        <div className="segmented small" aria-label="Chart zoom">
          <button onClick={() => zoomBy(1 / 1.5)} disabled={!hasChart || ve - vs <= MIN_SPAN} aria-label="Zoom in" title="Zoom in (or scroll on the chart)">
            +
          </button>
          <button onClick={() => zoomBy(1.5)} disabled={!view} aria-label="Zoom out" title="Zoom out">
            −
          </button>
          <button onClick={() => setView(null)} disabled={!view} title="Show the whole range (or double-click the chart)">
            Reset
          </button>
        </div>
        <div className="segmented" role="tablist" aria-label="Chart range">
          {RANGE_OPTIONS.map((r) => (
            <button key={r} role="tab" aria-selected={r === range} className={r === range ? 'active' : ''} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        {expanded ? (
          <button className="icon-btn" onClick={() => setExpanded(false)} aria-label="Close full view" title="Close (Esc)">
            ×
          </button>
        ) : (
          <button className="icon-btn" onClick={() => setExpanded(true)} disabled={!hasChart} aria-label="Open full view" title="Full view (or click the chart)">
            ⤢
          </button>
        )}
      </div>
    </div>
  );

  if (!hasChart) {
    return (
      <section className="card chart-card">
        {header}
        <div className="chart-empty">{error ? 'Price history is unavailable right now.' : <span className="skeleton chart-skeleton" />}</div>
      </section>
    );
  }

  // Visible points, plus one neighbour each side so the line runs to the plot edges.
  const first = Math.max(0, points.findIndex((pt) => pt.t >= vs) - 1);
  const after = points.findIndex((pt) => pt.t > ve);
  const shown = points.slice(first, after < 0 ? points.length : after + 1);
  const inView = shown.filter((pt) => pt.t >= vs && pt.t <= ve);
  const prices = (inView.length ? inView : shown).map((pt) => pt.p);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const padY = (hi - lo) * 0.1 || hi * 0.001;
  const yMin = lo - padY;
  const yMax = hi + padY;
  const x = (t: number) => PAD.left + ((t - vs) / (ve - vs || 1)) * PLOT_W;
  const y = (p: number) => PAD.top + (1 - (p - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const line = shown.map((pt, i) => `${i ? 'L' : 'M'}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join('');
  const baseline = H - PAD.bottom;
  const area = `${line}L${x(shown[shown.length - 1].t).toFixed(1)},${baseline}L${x(shown[0].t).toFixed(1)},${baseline}Z`;
  const hovered = hover != null ? inView[hover] : null;
  const last = points[points.length - 1];

  function onDown(e: React.PointerEvent<SVGSVGElement>) {
    if (!view || e.button !== 0) return;
    moved.current = false;
    drag.current = { x: e.clientX, view };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (drag.current) {
      const rect = svgRef.current!.getBoundingClientRect();
      const dt = ((e.clientX - drag.current.x) / rect.width) * (W / PLOT_W) * (ve - vs);
      if (Math.abs(e.clientX - drag.current.x) > 3) moved.current = true;
      const { start, end } = drag.current.view;
      setView(clampView({ start: start - dt, end: end - dt }, t0, t1));
      setHover(null);
      return;
    }
    if (!inView.length) return;
    const t = timeAt(e.clientX);
    let best = 0;
    for (let i = 1; i < inView.length; i++) {
      if (Math.abs(inView[i].t - t) < Math.abs(inView[best].t - t)) best = i;
    }
    setHover(best);
  }

  function onUp() {
    drag.current = null;
  }

  const chart = (
    <section className={`card chart-card${expanded ? ' expanded' : ''}`} onClick={(e) => e.stopPropagation()}>
      {header}
      <div className="chart">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className={`chart-svg${view ? ' zoomed' : ''}`}
          role="img"
          aria-label={`${symbol} price, ${range}: from ${fmtPrice(prices[0])} to ${fmtPrice(prices[prices.length - 1])}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={() => setHover(null)}
          onClick={() => {
            if (!expanded && !moved.current) setExpanded(true);
            moved.current = false;
          }}
          onDoubleClick={() => setView(null)}
        >
          <defs>
            <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-line)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--chart-line)" stopOpacity="0" />
            </linearGradient>
            <clipPath id="chart-plot">
              <rect x={PAD.left} y={0} width={PLOT_W} height={H} />
            </clipPath>
          </defs>
          {niceTicks(yMin, yMax).map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="chart-grid" />
              <text x={W - PAD.right + 10} y={y(v) + 4} className="chart-axis">
                {fmtPrice(v)}
              </text>
            </g>
          ))}
          {[0.2, 0.5, 0.8].map((f) => {
            const t = vs + (ve - vs) * f;
            return (
              <text key={f} x={x(t)} y={H - 8} className="chart-axis" textAnchor="middle">
                {fmtTime(t, ve - vs)}
              </text>
            );
          })}
          <g clipPath="url(#chart-plot)">
            <path d={area} fill="url(#chart-fill)" />
            <path d={line} fill="none" stroke="var(--chart-line)" strokeWidth={2} strokeLinejoin="round" />
          </g>
          {/* last-price marker + axis tag */}
          {last.p >= yMin && last.p <= yMax && (
            <>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(last.p)} y2={y(last.p)} className="chart-last" />
              <rect x={W - PAD.right + 4} y={y(last.p) - 10} width={PAD.right - 6} height={20} rx={4} className="chart-tag" />
              <text x={W - PAD.right + 10} y={y(last.p) + 4} className="chart-tag-text">
                {fmtPrice(last.p)}
              </text>
            </>
          )}
          {last.t <= ve && <circle cx={x(last.t)} cy={y(last.p)} r={4} fill="var(--chart-line)" stroke="var(--surface)" strokeWidth={2} />}
          {hovered && (
            <g pointerEvents="none">
              <line x1={x(hovered.t)} x2={x(hovered.t)} y1={PAD.top} y2={baseline} className="chart-crosshair" />
              <circle cx={x(hovered.t)} cy={y(hovered.p)} r={4} fill="var(--chart-line)" stroke="var(--surface)" strokeWidth={2} />
            </g>
          )}
        </svg>
        {hovered && (
          <div
            className="chart-tooltip"
            style={{ left: `${(x(hovered.t) / W) * 100}%`, transform: `translateX(${x(hovered.t) > W / 2 ? '-108%' : '8%'})` }}
          >
            <span className="faint">{new Date(hovered.t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <strong className="mono">${fmtPrice(hovered.p)}</strong>
          </div>
        )}
      </div>
    </section>
  );

  if (!expanded) return chart;
  return (
    <>
      <section className="card chart-card">
        {header}
        <div className="chart-empty">Chart is open in full view</div>
      </section>
      {createPortal(
        <div className="modal-backdrop" onClick={() => setExpanded(false)}>
          {chart}
        </div>,
        document.body,
      )}
    </>
  );
}
