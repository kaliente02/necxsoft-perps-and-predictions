import { useEffect, useMemo, useState } from 'react';
import type { Address } from '@solana/kit';
import { BPS, USD, type PerpsState, formatUsd, parseUsd, priceDecimals, signedUsd } from '../lib/perps';
import {
  Outcome,
  type PredictionInfo,
  type PredictionPositionInfo,
  buySharesIxs,
  formatCents,
  formatPercent,
  isPriceMarket,
  outcomeLabel,
  outcomePriceBps,
  positionValue,
  quoteBuy,
  quoteSell,
  redeemIxs,
  sellSharesIxs,
  yesPriceBps,
} from '../lib/predict';
import { usePredictionPositions, usePredictions, useProbabilityHistory } from '../hooks';
import { useTx } from '../tx';

const SLIPPAGE_BPS = 100n;

type Filter = 'open' | 'price' | 'custom' | 'resolved';

function selectedFromHash(): string | null {
  return window.location.hash.split('/')[2] || null;
}

function useSelected(): [string | null, (address: string) => void] {
  const [selected, setSelected] = useState(selectedFromHash);
  useEffect(() => {
    const onChange = () => setSelected(selectedFromHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const select = (address: string) => {
    window.history.replaceState(null, '', `#/predict/${address}`);
    setSelected(address);
  };
  return [selected, select];
}

function timeLeft(closeTime: bigint, now: bigint): string {
  const secs = Number(closeTime - now);
  if (secs <= 0) return 'Closed';
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${secs % 60}s`;
}

function status(m: PredictionInfo, now: bigint): { label: string; tone: 'open' | 'closing' | 'pending' | 'resolved' } {
  if (m.data.resolved) return { label: `Resolved ${outcomeLabel(m.data.outcome)}`, tone: 'resolved' };
  if (now >= m.data.closeTime) return { label: 'Awaiting resolution', tone: 'pending' };
  const left = Number(m.data.closeTime - now);
  return { label: `Closes in ${timeLeft(m.data.closeTime, now)}`, tone: left < 3_600 ? 'closing' : 'open' };
}

function kindLabel(m: PredictionInfo): string {
  return isPriceMarket(m.data) ? `${m.symbol ?? 'Price'} · Oracle` : 'Custom';
}

export function Predict({
  state,
  owner,
  usdcBalance,
  now,
}: {
  state: PerpsState;
  owner: Address | null;
  usdcBalance: bigint | undefined;
  now: bigint;
}) {
  const { data: markets, isLoading } = usePredictions(state);
  const positions = usePredictionPositions(owner).data ?? [];
  const [filter, setFilter] = useState<Filter>('open');
  const [selectedAddress, select] = useSelected();

  const all = markets ?? [];
  const visible = all.filter((m) =>
    filter === 'resolved'
      ? m.data.resolved
      : !m.data.resolved && (filter === 'open' || (filter === 'price') === isPriceMarket(m.data)),
  );
  const selected = all.find((m) => m.address === selectedAddress) ?? visible[0] ?? all[0];
  const position = positions.find((p) => p.data.market === selected?.address);

  const open = all.filter((m) => !m.data.resolved);
  const volume = all.reduce((sum, m) => sum + m.data.volume, 0n);
  const liquidity = open.reduce((sum, m) => sum + m.data.totalSets, 0n);

  return (
    <div className="predict">
      <section className="earn-hero">
        <span className="eyebrow">Necxsoft Predict</span>
        <h1>Trade on outcomes</h1>
        <p>
          Buy YES or NO shares on crypto prices and real-world questions. Prices move with demand and read as live
          probabilities. Each winning share pays $1 USDC.
        </p>
      </section>

      <dl className="stat-grid">
        <div className="card stat">
          <dt>Open markets</dt>
          <dd className="mono">{open.length}</dd>
        </div>
        <div className="card stat">
          <dt>Total volume</dt>
          <dd className="mono">${formatUsd(volume, 0)}</dd>
        </div>
        <div className="card stat">
          <dt>Open interest</dt>
          <dd className="mono">${formatUsd(liquidity, 0)}</dd>
        </div>
        <div className="card stat">
          <dt>Your positions</dt>
          <dd className="mono">{owner ? positions.length : '—'}</dd>
        </div>
      </dl>

      <div className="trade-grid">
        <div className="trade-main">
          {selected ? (
            <MarketDetail market={selected} now={now} />
          ) : (
            <section className="card empty">
              {isLoading ? <span className="spinner" aria-hidden /> : <strong>No prediction markets yet</strong>}
              {!isLoading && (
                <span className="faint">
                  Create some with <code className="mono">npm run setup -- predict-demo</code>, or run the keeper to open rolling price markets.
                </span>
              )}
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Markets</h2>
              <div className="segmented" role="tablist" aria-label="Filter markets">
                {(['open', 'price', 'custom', 'resolved'] as const).map((f) => (
                  <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                    {f === 'open' ? 'All open' : f[0].toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            {visible.length === 0 ? (
              <div className="empty">
                <span className="faint">{isLoading ? 'Loading markets…' : 'Nothing here yet.'}</span>
              </div>
            ) : (
              <ul className="market-grid">
                {visible.map((m) => (
                  <li key={m.address}>
                    <MarketCard market={m} now={now} active={m.address === selected?.address} onSelect={() => select(m.address)} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <MyPredictions state={state} markets={all} positions={positions} connected={!!owner} onSelect={select} />
        </div>

        <div className="trade-side">
          {selected && (
            <TradePanel state={state} market={selected} position={position} usdcBalance={usdcBalance} connected={!!owner} now={now} />
          )}
          <section className="card">
            <h2 className="card-title">How it works</h2>
            <ol className="steps">
              <li>
                <strong>Pick a side</strong>
                <span className="faint">A YES share at 63¢ means the market puts the odds at 63%.</span>
              </li>
              <li>
                <strong>Trade any time</strong>
                <span className="faint">An on-chain AMM always quotes a price, so you can buy or sell before the market closes.</span>
              </li>
              <li>
                <strong>Get paid</strong>
                <span className="faint">
                  Price markets settle from the perps oracle at close. Custom questions are settled by the exchange admin.
                  Winning shares redeem for $1.
                </span>
              </li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}

function ProbabilityBar({ yesBps }: { yesBps: bigint }) {
  return (
    <div className="prob-bar" role="img" aria-label={`Yes ${formatPercent(yesBps)}, No ${formatPercent(BPS - yesBps)}`}>
      <span className="prob-yes" style={{ width: `${Number(yesBps) / 100}%` }} />
    </div>
  );
}

function MarketCard({ market, now, active, onSelect }: { market: PredictionInfo; now: bigint; active: boolean; onSelect: () => void }) {
  const yes = yesPriceBps(market.data);
  const s = status(market, now);
  return (
    <button className={`market-card ${active ? 'active' : ''}`} onClick={onSelect} aria-pressed={active}>
      <span className="market-card-top">
        <span className="tag">{kindLabel(market)}</span>
        <span className={`status ${s.tone}`}>{s.label}</span>
      </span>
      <span className="market-question">{market.data.question}</span>
      {market.data.resolved ? (
        <span className={`outcome-chip ${market.data.outcome === Outcome.Yes ? 'yes' : market.data.outcome === Outcome.No ? 'no' : ''}`}>
          {outcomeLabel(market.data.outcome)}
        </span>
      ) : (
        <>
          <span className="market-odds">
            <span className="pos mono">Yes {formatCents(yes)}</span>
            <span className="neg mono">No {formatCents(BPS - yes)}</span>
          </span>
          <ProbabilityBar yesBps={yes} />
        </>
      )}
      <span className="faint small">${formatUsd(market.data.volume, 0)} volume</span>
    </button>
  );
}

function MarketDetail({ market, now }: { market: PredictionInfo; now: bigint }) {
  const { data } = market;
  const yes = yesPriceBps(data);
  const s = status(market, now);
  const close = new Date(Number(data.closeTime) * 1000);
  return (
    <section className="card market-detail">
      <div className="market-card-top">
        <span className="tag">{kindLabel(market)}</span>
        <span className={`status ${s.tone}`}>{s.label}</span>
      </div>
      <h2 className="detail-question">{data.question}</h2>
      <div className="detail-odds">
        {data.resolved ? (
          <div>
            <span className="eyebrow">Outcome</span>
            <span className={`big mono ${data.outcome === Outcome.Yes ? 'pos' : data.outcome === Outcome.No ? 'neg' : 'warn'}`}>
              {outcomeLabel(data.outcome)}
            </span>
          </div>
        ) : (
          <div>
            <span className="eyebrow">Chance of Yes</span>
            <span className="big mono pos">{formatPercent(yes)}</span>
          </div>
        )}
        <dl className="detail-stats">
          <div><dt>Volume</dt><dd className="mono">${formatUsd(data.volume)}</dd></div>
          <div><dt>Liquidity</dt><dd className="mono">${formatUsd(data.totalSets, 0)}</dd></div>
          <div><dt>{data.resolved ? 'Resolved' : 'Closes'}</dt><dd>{(data.resolved ? new Date(Number(data.resolvedAt) * 1000) : close).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd></div>
          <div><dt>Fee</dt><dd className="mono">{data.feeBps / 100}%</dd></div>
        </dl>
      </div>
      <ProbabilityChart market={market} />
      <p className="fine left">
        {isPriceMarket(data)
          ? `Resolves YES if the ${market.symbol ?? ''} oracle price is at or above $${formatUsd(data.strike, priceDecimals(data.strike))} at the first update after close; anyone can trigger settlement.${data.resolved && data.resolvedPrice > 0n ? ` Settled at $${formatUsd(data.resolvedPrice, priceDecimals(data.resolvedPrice))}.` : ''}`
          : 'Resolved by the Necxsoft exchange admin. If the question cannot be answered, it resolves Invalid and every share redeems for 50¢.'}
      </p>
    </section>
  );
}

const CW = 760;
const CH = 200;
const CP = { top: 12, right: 44, bottom: 22, left: 4 };

function ProbabilityChart({ market }: { market: PredictionInfo }) {
  const { data: history } = useProbabilityHistory(market.address);
  const [hover, setHover] = useState<number | null>(null);
  const current = Number(yesPriceBps(market.data));

  const points = useMemo(() => {
    const start = { t: Number(market.data.createdAt), yesBps: market.data.initialYesBps };
    const end = { t: market.data.resolved ? Number(market.data.resolvedAt) : Math.floor(Date.now() / 1000), yesBps: current };
    return [start, ...(history ?? []), end];
  }, [history, current, market.data]);

  const t0 = points[0].t;
  const t1 = Math.max(points[points.length - 1].t, t0 + 1);
  const x = (t: number) => CP.left + ((t - t0) / (t1 - t0)) * (CW - CP.left - CP.right);
  const y = (bps: number) => CP.top + (1 - bps / 10_000) * (CH - CP.top - CP.bottom);
  // Step line: the price holds until the next trade.
  let d = `M${x(points[0].t)},${y(points[0].yesBps)}`;
  for (const p of points.slice(1)) d += `H${x(p.t)}V${y(p.yesBps)}`;
  const area = `${d}V${y(0)}H${x(points[0].t)}Z`;
  const hovered = hover != null ? points[hover] : null;

  return (
    <div className="chart prob-chart">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${CW} ${CH}`}
        role="img"
        aria-label={`Chance of Yes over time, now ${(current / 100).toFixed(0)}%`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const t = t0 + (((e.clientX - rect.left) / rect.width) * CW - CP.left) / (CW - CP.left - CP.right) * (t1 - t0);
          let i = 0;
          while (i + 1 < points.length && points[i + 1].t <= t) i++;
          setHover(i);
        }}
      >
        <defs>
          <linearGradient id="prob-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--long)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--long)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="chart-grid">
          {[0, 2_500, 5_000, 7_500, 10_000].map((v) => (
            <line key={v} x1={CP.left} x2={CW - CP.right} y1={y(v)} y2={y(v)} />
          ))}
        </g>
        {[0, 2_500, 5_000, 7_500, 10_000].map((v) => (
          <text key={v} className="chart-axis" x={CW - CP.right + 8} y={y(v) + 4}>
            {v / 100}%
          </text>
        ))}
        <path d={area} fill="url(#prob-fill)" />
        <path d={d} fill="none" stroke="var(--long-text)" strokeWidth={2} strokeLinejoin="round" />
        <circle cx={x(points[points.length - 1].t)} cy={y(current)} r={4} fill="var(--long-text)" />
        {hovered && (
          <g>
            <line className="chart-crosshair" x1={x(hovered.t)} x2={x(hovered.t)} y1={CP.top} y2={CH - CP.bottom} />
            <circle cx={x(hovered.t)} cy={y(hovered.yesBps)} r={4} fill="var(--long-text)" />
          </g>
        )}
        <text className="chart-axis" x={CP.left} y={CH - 4}>
          {new Date(t0 * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </text>
        <text className="chart-axis" x={CW - CP.right} y={CH - 4} textAnchor="end">
          {market.data.resolved ? 'Resolved' : 'Now'}
        </text>
      </svg>
      {hovered && (
        <div className="chart-tooltip" style={{ left: `${(x(hovered.t) / CW) * 100}%`, top: 0 }}>
          <span className="mono">Yes {(hovered.yesBps / 100).toFixed(1)}%</span>
          <span className="faint small">{new Date(hovered.t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      )}
    </div>
  );
}

function TradePanel({
  state,
  market,
  position,
  usdcBalance,
  connected,
  now,
}: {
  state: PerpsState;
  market: PredictionInfo;
  position: PredictionPositionInfo | undefined;
  usdcBalance: bigint | undefined;
  connected: boolean;
  now: bigint;
}) {
  const { run, isRunning } = useTx();
  const [buy, setBuy] = useState(true);
  const [outcome, setOutcome] = useState<Outcome>(Outcome.Yes);
  const [amount, setAmount] = useState('');
  useEffect(() => setAmount(''), [market.address, buy, outcome]);

  const { data } = market;
  const held = position ? (outcome === Outcome.Yes ? position.data.yesShares : position.data.noShares) : 0n;
  const value = parseUsd(amount) ?? 0n;
  const quote = buy ? quoteBuy(data, outcome, value) : quoteSell(data, outcome, value);
  const yes = yesPriceBps(data);
  const closed = data.resolved || now >= data.closeTime;
  const isYes = outcome === Outcome.Yes;

  if (data.resolved) {
    const payout = position ? positionValue(data, position.data) : 0n;
    return (
      <section className="card order">
        <h2 className="card-title">Market resolved</h2>
        <div className="size-row">
          <span className="faint">Outcome</span>
          <span className={`strong ${data.outcome === Outcome.Yes ? 'pos' : data.outcome === Outcome.No ? 'neg' : 'warn'}`}>
            {outcomeLabel(data.outcome)}
          </span>
        </div>
        {position ? (
          <>
            <PositionSummary market={market} position={position} />
            <button
              className="btn btn-primary btn-block"
              disabled={isRunning}
              onClick={() => run(payout > 0n ? 'Redeem winnings' : 'Close position', (signer) => redeemIxs(state, signer, market.address))}
            >
              {isRunning ? 'Waiting for wallet…' : payout > 0n ? `Redeem $${formatUsd(payout)}` : 'Close position (no payout)'}
            </button>
          </>
        ) : (
          <p className="faint">{connected ? 'You had no position in this market.' : 'Connect a wallet to see your position.'}</p>
        )}
      </section>
    );
  }

  let problem: string | null = null;
  if (!connected) problem = 'Connect wallet';
  else if (closed) problem = 'Trading closed, awaiting resolution';
  else if (value <= 0n) problem = buy ? 'Enter an amount' : 'Enter shares to sell';
  else if (buy && usdcBalance !== undefined && value > usdcBalance) problem = 'Insufficient USDC balance';
  else if (!buy && value > held) problem = `You hold ${formatUsd(held)} ${outcomeLabel(outcome)} shares`;
  else if (!quote) problem = 'Amount too small';

  const minOut = quote ? ((buy ? quote.shares : quote.amount) * (BPS - SLIPPAGE_BPS)) / BPS : 0n;
  const priceNow = outcomePriceBps(data, outcome);

  return (
    <section className="card order">
      <div className="segmented full" role="tablist" aria-label="Buy or sell">
        <button role="tab" aria-selected={buy} className={buy ? 'active' : ''} onClick={() => setBuy(true)}>Buy</button>
        <button role="tab" aria-selected={!buy} className={!buy ? 'active' : ''} onClick={() => setBuy(false)}>Sell</button>
      </div>

      <div className={`side-toggle ${isYes ? 'is-long' : 'is-short'}`} role="radiogroup" aria-label="Outcome">
        <span className="side-indicator" aria-hidden />
        <button role="radio" aria-checked={isYes} className={isYes ? 'active' : ''} onClick={() => setOutcome(Outcome.Yes)}>
          Yes {formatCents(yes)}
        </button>
        <button role="radio" aria-checked={!isYes} className={!isYes ? 'active' : ''} onClick={() => setOutcome(Outcome.No)}>
          No {formatCents(BPS - yes)}
        </button>
      </div>

      <label className="field">
        <span className="field-label">
          <span>{buy ? 'Amount' : 'Shares'}</span>
          {buy
            ? usdcBalance !== undefined && (
                <button type="button" className="link" onClick={() => setAmount(formatUsd(usdcBalance).replace(/,/g, ''))}>
                  Balance {formatUsd(usdcBalance)}
                </button>
              )
            : (
                <button type="button" className="link" onClick={() => setAmount((Number(held) / 1e6).toString())}>
                  Held {formatUsd(held)}
                </button>
              )}
        </span>
        <div className="input">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-label={buy ? 'USDC amount' : 'Shares'} />
          <span className="unit">{buy ? 'USDC' : 'Shares'}</span>
        </div>
      </label>
      <div className="presets">
        {buy
          ? [10n, 50n, 100n, 500n].map((n) => (
              <button key={String(n)} type="button" className="chip" onClick={() => setAmount(n.toString())}>
                ${n.toString()}
              </button>
            ))
          : [25n, 50n, 100n].map((pct) => (
              <button key={String(pct)} type="button" className="chip" disabled={held === 0n} onClick={() => setAmount((Number((held * pct) / 100n) / 1e6).toString())}>
                {pct.toString()}%
              </button>
            ))}
      </div>

      <dl className="kv">
        <div><dt>Price now</dt><dd className="mono">{formatCents(priceNow)}</dd></div>
        <div><dt>Average price</dt><dd className="mono">{quote ? formatCents(quote.avgPriceBps) : '—'}</dd></div>
        {buy ? (
          <>
            <div><dt>Shares</dt><dd className="mono">{quote ? formatUsd(quote.shares) : '—'}</dd></div>
            <div>
              <dt>Payout if {outcomeLabel(outcome)}</dt>
              <dd className="mono pos">
                {quote ? `$${formatUsd(quote.shares)} (${signedUsd(quote.shares - quote.amount)})` : '—'}
              </dd>
            </div>
          </>
        ) : (
          <div><dt>You receive</dt><dd className="mono">{quote ? `$${formatUsd(quote.amount)}` : '—'}</dd></div>
        )}
        <div>
          <dt>Chance of Yes after</dt>
          <dd className="mono">{quote ? `${formatPercent(yes)} → ${formatPercent(quote.yesAfterBps)}` : formatPercent(yes)}</dd>
        </div>
        <div><dt>Fee ({data.feeBps / 100}%)</dt><dd className="mono">{quote ? `$${formatUsd(quote.fee)}` : '—'}</dd></div>
      </dl>

      <button
        className={`btn btn-block ${problem ? 'btn-secondary' : isYes ? 'btn-long' : 'btn-short'}`}
        disabled={problem != null || isRunning}
        onClick={() =>
          run(`${buy ? 'Buy' : 'Sell'} ${outcomeLabel(outcome)}`, (signer) =>
            buy
              ? buySharesIxs({ state, owner: signer, market: market.address, outcome, amount: value, minShares: minOut })
              : sellSharesIxs({ state, owner: signer, market: market.address, outcome, shares: value, minOut }),
          )
        }
      >
        {problem ?? (isRunning ? 'Waiting for wallet…' : `${buy ? 'Buy' : 'Sell'} ${outcomeLabel(outcome)}`)}
      </button>
      <p className="fine">1% slippage tolerance. Shares stay tradable until the market closes.</p>

      {position && <PositionSummary market={market} position={position} />}
    </section>
  );
}

function PositionSummary({ market, position }: { market: PredictionInfo; position: PredictionPositionInfo }) {
  const value = positionValue(market.data, position.data);
  const pnl = value - position.data.netCost;
  return (
    <dl className="kv compact">
      <div><dt>Your Yes shares</dt><dd className="mono">{formatUsd(position.data.yesShares)}</dd></div>
      <div><dt>Your No shares</dt><dd className="mono">{formatUsd(position.data.noShares)}</dd></div>
      <div><dt>{market.data.resolved ? 'Payout' : 'Value'}</dt><dd className="mono">${formatUsd(value)}</dd></div>
      <div><dt>PnL</dt><dd className={`mono ${pnl >= 0n ? 'pos' : 'neg'}`}>{signedUsd(pnl)}</dd></div>
    </dl>
  );
}

function MyPredictions({
  state,
  markets,
  positions,
  connected,
  onSelect,
}: {
  state: PerpsState;
  markets: PredictionInfo[];
  positions: PredictionPositionInfo[];
  connected: boolean;
  onSelect: (address: string) => void;
}) {
  const { run, isRunning } = useTx();
  const rows = positions.flatMap((p) => {
    const market = markets.find((m) => m.address === p.data.market);
    return market ? [{ p, market, value: positionValue(market.data, p.data) }] : [];
  });
  const total = rows.reduce((sum, r) => sum + r.value - r.p.data.netCost, 0n);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          Your predictions {rows.length > 0 && <span className="count">{rows.length}</span>}
        </h2>
        {rows.length > 0 && (
          <span className="faint">
            Total PnL <span className={total >= 0n ? 'pos' : 'neg'}>{signedUsd(total)}</span>
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <span className="faint">{connected ? 'No predictions yet. Pick a market and buy Yes or No.' : 'Connect a wallet to see your predictions.'}</span>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Market</th>
                <th className="num">Yes</th>
                <th className="num">No</th>
                <th className="num">Value</th>
                <th className="num">PnL</th>
                <th className="num" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, market, value }) => {
                const pnl = value - p.data.netCost;
                return (
                  <tr key={p.address}>
                    <td>
                      <button className="link question-link" onClick={() => onSelect(market.address)}>
                        {market.data.question}
                      </button>
                      <span className="sub faint">
                        {market.data.resolved ? `Resolved ${outcomeLabel(market.data.outcome)}` : kindLabel(market)}
                      </span>
                    </td>
                    <td className="num mono">{formatUsd(p.data.yesShares)}</td>
                    <td className="num mono">{formatUsd(p.data.noShares)}</td>
                    <td className="num mono">${formatUsd(value)}</td>
                    <td className={`num mono ${pnl >= 0n ? 'pos' : 'neg'}`}>{signedUsd(pnl)}</td>
                    <td className="num">
                      {market.data.resolved ? (
                        <button
                          className="btn btn-primary btn-small"
                          disabled={isRunning}
                          onClick={() => run('Redeem winnings', (signer) => redeemIxs(state, signer, market.address))}
                        >
                          {value > 0n ? 'Redeem' : 'Close'}
                        </button>
                      ) : (
                        <button className="btn btn-secondary btn-small" onClick={() => onSelect(market.address)}>
                          Trade
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine left">Value uses current AMM prices; winning shares redeem for {formatUsd(USD)} USDC each after resolution.</p>
    </section>
  );
}
