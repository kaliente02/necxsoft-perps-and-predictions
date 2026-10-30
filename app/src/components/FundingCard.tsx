import { useState } from 'react';
import { useMarketHistory } from '../hooks';
import { fundingBars } from '../lib/history';
import { BORROW_RATE_SCALE, type MarketInfo, formatHourlyRate, formatUsd } from '../lib/perps';

const W = 760;
const H = 150;
const P = { top: 10, right: 64, bottom: 20, left: 4 };
/** Gap between bars, in viewBox units. */
const GAP = 2;

const pct = (rate: bigint) => (Number(rate) / Number(BORROW_RATE_SCALE)) * 100;
const when = (t: number) => new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Hourly funding for one market: the live rate, realized averages and a bar per hourly sample.
 * Bars above zero are hours when longs paid shorts, bars below zero hours when shorts paid longs.
 */
export function FundingCard({ market, now }: { market: MarketInfo; now: bigint }) {
  const { data: samples, isLoading } = useMarketHistory(market.address);
  const [hover, setHover] = useState<number | null>(null);
  const bars = fundingBars(samples ?? [], market.data, now);
  const live = market.data.fundingRate;

  const day = bars.filter((b) => b.end > Number(now) - 86_400);
  const daySeconds = day.reduce((s, b) => s + (b.end - b.start), 0);
  const dayAvg = daySeconds > 0 ? day.reduce((s, b) => s + pct(b.rate) * (b.end - b.start), 0) / daySeconds : null;
  const longOi = market.data.longOpenInterest;
  const shortOi = market.data.shortOpenInterest;
  const totalOi = longOi + shortOi;
  const skew = totalOi > 0n ? (Number(longOi - shortOi) / Number(totalOi)) * 100 : 0;

  const t0 = bars[0]?.start ?? 0;
  const t1 = Math.max(bars[bars.length - 1]?.end ?? 1, t0 + 1);
  const cap = pct(market.data.maxHourlyFundingRate);
  const max = Math.max(cap, ...bars.map((b) => Math.abs(pct(b.rate))), 0.0001);
  const x = (t: number) => P.left + ((t - t0) / (t1 - t0)) * (W - P.left - P.right);
  const y = (v: number) => P.top + (1 - (v + max) / (2 * max)) * (H - P.top - P.bottom);
  const hovered = hover != null ? bars[hover] : null;

  return (
    <section className="card funding-card" aria-label={`${market.symbol} funding`}>
      <div className="card-head">
        <h2 className="card-title">Funding</h2>
        <div className="legend small">
          <span><i className="swatch long" aria-hidden /> Longs pay</span>
          <span><i className="swatch short" aria-hidden /> Shorts pay</span>
        </div>
      </div>
      <dl className="funding-stats">
        <div>
          <dt>Current (1h)</dt>
          <dd className="mono">{formatHourlyRate(live, true)}</dd>
        </div>
        <div>
          <dt>24h average</dt>
          <dd className="mono">{dayAvg == null ? '—' : `${dayAvg > 0 ? '+' : ''}${dayAvg.toFixed(4)}%`}</dd>
        </div>
        <div>
          <dt>Annualized</dt>
          <dd className="mono">{`${pct(live) > 0 ? '+' : ''}${(pct(live) * 24 * 365).toFixed(2)}%`}</dd>
        </div>
        <div>
          <dt>OI skew</dt>
          <dd className="mono">{totalOi > 0n ? `${skew > 0 ? '+' : ''}${skew.toFixed(0)}% ${skew >= 0 ? 'long' : 'short'}` : '—'}</dd>
        </div>
        <div>
          <dt>Max at full skew</dt>
          <dd className="mono">{formatHourlyRate(market.data.maxHourlyFundingRate)}</dd>
        </div>
      </dl>

      {bars.length === 0 ? (
        <p className="faint small chart-empty">
          {isLoading ? 'Loading funding history…' : 'Funding history starts with the next hourly sample.'}
        </p>
      ) : (
        <div className="chart funding-chart">
          <svg
            className="chart-svg"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${market.symbol} hourly funding over the last ${Math.round((t1 - t0) / 3600)} hours, now ${formatHourlyRate(live, true)} per hour`}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const t = t0 + ((((e.clientX - rect.left) / rect.width) * W - P.left) / (W - P.left - P.right)) * (t1 - t0);
              const i = bars.findIndex((b) => t >= b.start && t < b.end);
              setHover(i >= 0 ? i : t >= t1 ? bars.length - 1 : null);
            }}
          >
            <g className="chart-grid">
              {[-max, 0, max].map((v) => (
                <line key={v} x1={P.left} x2={W - P.right} y1={y(v)} y2={y(v)} />
              ))}
            </g>
            {[max, 0, -max].map((v) => (
              <text key={v} className="chart-axis" x={W - P.right + 8} y={y(v) + 4}>
                {v === 0 ? '0%' : `${v > 0 ? '+' : ''}${v.toFixed(4)}%`}
              </text>
            ))}
            {bars.map((b, i) => {
              const v = pct(b.rate);
              const left = x(b.start) + GAP / 2;
              const width = Math.max(1, x(b.end) - x(b.start) - GAP);
              const top = Math.min(y(v), y(0));
              const height = Math.max(Math.abs(y(v) - y(0)), v === 0 ? 0 : 1);
              return (
                <rect
                  key={b.start}
                  x={left}
                  y={top}
                  width={width}
                  height={height}
                  rx={Math.min(2, width / 2)}
                  className={`funding-bar ${v >= 0 ? 'long' : 'short'} ${hover === i ? 'active' : ''}`}
                />
              );
            })}
            <line className="funding-zero" x1={P.left} x2={W - P.right} y1={y(0)} y2={y(0)} />
            {hovered && <line className="chart-crosshair" x1={x((hovered.start + hovered.end) / 2)} x2={x((hovered.start + hovered.end) / 2)} y1={P.top} y2={H - P.bottom} />}
            <text className="chart-axis" x={P.left} y={H - 4}>{when(t0)}</text>
            <text className="chart-axis" x={W - P.right} y={H - 4} textAnchor="end">Now</text>
          </svg>
          {hovered && (
            <div className="chart-tooltip" style={{ left: `${(x((hovered.start + hovered.end) / 2) / W) * 100}%`, top: 0 }}>
              <span className="mono">{formatHourlyRate(hovered.rate, true)} / h</span>
              <span className="faint small">
                {hovered.rate > 0n ? 'Longs paid shorts' : hovered.rate < 0n ? 'Shorts paid longs' : 'No funding'} · OI L ${formatUsd(hovered.longOpenInterest, 0)} / S ${formatUsd(hovered.shortOpenInterest, 0)}
              </span>
              <span className="faint small">{when(hovered.start)} – {hover === bars.length - 1 ? 'now' : when(hovered.end)}</span>
            </div>
          )}
        </div>
      )}
      <p className="fine left">
        The heavier side pays funding and the lighter side earns it at the same rate: up to {formatHourlyRate(market.data.maxHourlyFundingRate)} of size per hour, in proportion to the open-interest skew. The pool keeps the difference, so funding never costs LPs. It settles with borrow fees whenever a position changes.
      </p>
    </section>
  );
}
