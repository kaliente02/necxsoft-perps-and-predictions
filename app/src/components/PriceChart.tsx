import { useEffect, useMemo, useRef, useState } from 'react';
import { type Point, type Range, RANGE_OPTIONS, useCandles } from '../lib/candles';

const W = 760;
const H = 300;
const PAD = { top: 16, right: 70, bottom: 28, left: 8 };

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

function fmtTime(t: number, range: Range) {
  const d = new Date(t * 1000);
  return range === '1W'
    ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

  const points = useMemo(() => {
    const base = history ?? [];
    const lastT = base.length ? base[base.length - 1].t : 0;
    return [...base, ...live.filter((pt) => pt.t > lastT)];
  }, [history, live]);

  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const header = (
    <div className="card-head">
      <h2 className="card-title">Price</h2>
      <div className="segmented" role="tablist" aria-label="Chart range">
        {RANGE_OPTIONS.map((r) => (
          <button key={r} role="tab" aria-selected={r === range} className={r === range ? 'active' : ''} onClick={() => setRange(r)}>
            {r}
          </button>
        ))}
      </div>
    </div>
  );

  if (points.length < 2) {
    return (
      <section className="card chart-card">
        {header}
        <div className="chart-empty">{error ? 'Price history is unavailable right now.' : <span className="skeleton chart-skeleton" />}</div>
      </section>
    );
  }

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const prices = points.map((pt) => pt.p);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const padY = (hi - lo) * 0.1 || hi * 0.001;
  const yMin = lo - padY;
  const yMax = hi + padY;
  const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0 || 1)) * (W - PAD.left - PAD.right);
  const y = (p: number) => PAD.top + (1 - (p - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const line = points.map((pt, i) => `${i ? 'L' : 'M'}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join('');
  const baseline = H - PAD.bottom;
  const area = `${line}L${x(t1).toFixed(1)},${baseline}L${x(t0).toFixed(1)},${baseline}Z`;
  const hovered = hover != null ? points[hover] : null;
  const last = points[points.length - 1];

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((sx - PAD.left) / (W - PAD.left - PAD.right)) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    }
    setHover(best);
  }

  return (
    <section className="card chart-card">
      {header}
      <div className="chart">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="chart-svg"
          role="img"
          aria-label={`${symbol} price, ${range}: from ${fmtPrice(prices[0])} to ${fmtPrice(last.p)}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-line)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--chart-line)" stopOpacity="0" />
            </linearGradient>
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
            const t = t0 + (t1 - t0) * f;
            return (
              <text key={f} x={x(t)} y={H - 8} className="chart-axis" textAnchor="middle">
                {fmtTime(t, range)}
              </text>
            );
          })}
          <path d={area} fill="url(#chart-fill)" />
          <path d={line} fill="none" stroke="var(--chart-line)" strokeWidth={2} strokeLinejoin="round" />
          {/* last-price marker + axis tag */}
          <line x1={PAD.left} x2={W - PAD.right} y1={y(last.p)} y2={y(last.p)} className="chart-last" />
          <rect x={W - PAD.right + 4} y={y(last.p) - 10} width={PAD.right - 6} height={20} rx={4} className="chart-tag" />
          <text x={W - PAD.right + 10} y={y(last.p) + 4} className="chart-tag-text">
            {fmtPrice(last.p)}
          </text>
          <circle cx={x(last.t)} cy={y(last.p)} r={4} fill="var(--chart-line)" stroke="var(--surface)" strokeWidth={2} />
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
}
