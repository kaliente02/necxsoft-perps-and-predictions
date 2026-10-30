import { useState } from 'react';
import type { Address } from '@solana/kit';
import { type MarketInfo, OrderKind, Side, USD, formatUsd, priceDecimals } from '../lib/perps';
import { useAllOrders, useLiquidations, useMarketTrades } from '../hooks';
import { explorerTxUrl } from '../client';

const LEVELS = 8;

type Level = { price: bigint; size: bigint; total: bigint; count: number; mine: boolean };

/** Base grouping step: about 1/1000th of the price, rounded to a power of ten (SOL $0.01, BTC $10). */
function baseTick(price: bigint): bigint {
  const digits = (price / USD).toString().length;
  return 10n ** BigInt(Math.max(0, digits + 6 - 4));
}

function group(orders: { price: bigint; size: bigint; mine: boolean }[], tick: bigint, bids: boolean): Level[] {
  const levels = new Map<bigint, Level>();
  for (const o of orders) {
    // Round away from the mark so a level never looks better than its orders.
    const price = bids ? (o.price / tick) * tick : ((o.price + tick - 1n) / tick) * tick;
    const level = levels.get(price) ?? { price, size: 0n, total: 0n, count: 0, mine: false };
    level.size += o.size;
    level.count += 1;
    level.mine ||= o.mine;
    levels.set(price, level);
  }
  const sorted = [...levels.values()].sort((a, b) => (bids ? Number(b.price - a.price) : Number(a.price - b.price))).slice(0, LEVELS);
  let total = 0n;
  for (const l of sorted) l.total = total += l.size;
  return sorted;
}

export function OrderBook({ market, markets, owner }: { market: MarketInfo; markets: MarketInfo[]; owner: Address | null }) {
  const [tab, setTab] = useState<'book' | 'trades' | 'liquidations'>('book');
  const [scale, setScale] = useState(1n);
  const { data: orders, isLoading } = useAllOrders();
  const mark = market.data.price;
  const dp = priceDecimals(mark);
  const tick = baseTick(mark) * scale;

  const limits = (orders ?? []).filter((o) => o.data.market === market.address && o.data.kind === OrderKind.Limit);
  const toRow = (o: (typeof limits)[number]) => ({ price: o.data.triggerPrice, size: o.data.sizeUsd, mine: o.data.owner === owner });
  const bids = group(limits.filter((o) => o.data.side === Side.Long).map(toRow), tick, true);
  const asks = group(limits.filter((o) => o.data.side === Side.Short).map(toRow), tick, false);
  const maxTotal = [...bids, ...asks].reduce((m, l) => (l.total > m ? l.total : m), 0n);
  const spread = bids[0] && asks[0] ? asks[0].price - bids[0].price : null;
  const tickLabel = `$${formatUsd(tick, tick >= USD ? 0 : Math.min(6, 6 - (tick.toString().length - 1)))}`;

  const row = (l: Level, side: 'bid' | 'ask') => (
    <li key={`${side}-${l.price}`} className={`book-row ${side}`} title={`${l.count} order${l.count === 1 ? '' : 's'}`}>
      <span
        className="book-depth"
        style={{ width: `${maxTotal > 0n ? Number((l.total * 1000n) / maxTotal) / 10 : 0}%` }}
        aria-hidden
      />
      <span className="mono book-price">
        {l.mine && <span className="book-mine" aria-label="Includes your order" />}
        {formatUsd(l.price, dp)}
      </span>
      <span className="mono num">{formatUsd(l.size, 0)}</span>
      <span className="mono num faint">{formatUsd(l.total, 0)}</span>
    </li>
  );

  return (
    <section className="card book-card">
      <div className="card-head">
        <div className="segmented small" role="tablist" aria-label="Order book">
          <button role="tab" aria-selected={tab === 'book'} className={tab === 'book' ? 'active' : ''} onClick={() => setTab('book')}>Book</button>
          <button role="tab" aria-selected={tab === 'trades'} className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>Trades</button>
          <button role="tab" aria-selected={tab === 'liquidations'} className={tab === 'liquidations' ? 'active' : ''} onClick={() => setTab('liquidations')}>Liqs</button>
        </div>
        {tab === 'book' && (
          <button
            className="chip book-tick"
            onClick={() => setScale((s) => (s >= 100n ? 1n : s * 10n))}
            title="Change price grouping"
          >
            {tickLabel}
          </button>
        )}
      </div>

      {tab === 'book' ? (
        <>
          <div className="book-head">
            <span>Price</span>
            <span className="num">Size (USD)</span>
            <span className="num">Total</span>
          </div>
          <ul className="book-side asks">{[...asks].reverse().map((l) => row(l, 'ask'))}</ul>
          <div className="book-mid">
            <span className="mono strong">${formatUsd(mark, dp)}</span>
            <span className="faint small">
              {spread != null ? `Spread $${formatUsd(spread, dp)}` : 'Oracle mark'}
            </span>
          </div>
          <ul className="book-side bids">{bids.map((l) => row(l, 'bid'))}</ul>
          {!isLoading && bids.length + asks.length === 0 && (
            <p className="book-empty faint small">No resting limit orders yet. Place one from the Limit tab.</p>
          )}
          <p className="fine left">
            Resting limit orders from every trader. Market orders fill instantly at the oracle price against the pool, so they never wait in the book.
          </p>
        </>
      ) : tab === 'trades' ? (
        <TradesFeed market={market} />
      ) : (
        <LiquidationFeed markets={markets} owner={owner} />
      )}
    </section>
  );
}

function TradesFeed({ market }: { market: MarketInfo }) {
  const { data: trades, isLoading } = useMarketTrades(market.address);
  const dp = priceDecimals(market.data.price);
  if (!trades?.length) {
    return <p className="book-empty faint small">{isLoading ? 'Loading trades…' : 'No trades on this market yet.'}</p>;
  }
  return (
    <>
      <div className="book-head">
        <span>Price</span>
        <span className="num">Size (USD)</span>
        <span className="num">Time</span>
      </div>
      <ul className="book-side trades">
        {trades.map((t, i) => (
          <li key={`${t.signature}-${i}`} className="book-row">
            <a className={`mono book-price ${t.buy ? 'pos' : 'neg'}`} href={explorerTxUrl(t.signature)} target="_blank" rel="noreferrer" title={t.label}>
              {formatUsd(t.price, dp)}
            </a>
            <span className="mono num">{formatUsd(t.size, 0)}</span>
            <span className="mono num faint">
              {t.time ? new Date(t.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function ago(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Every market's recent liquidations, from the exchange's on-chain feed. */
function LiquidationFeed({ markets, owner }: { markets: MarketInfo[]; owner: Address | null }) {
  const { data: liquidations, isLoading } = useLiquidations();
  const now = Math.floor(Date.now() / 1000);
  if (!liquidations?.length) {
    return <p className="book-empty faint small">{isLoading ? 'Loading liquidations…' : 'No liquidations yet.'}</p>;
  }
  return (
    <>
      <div className="book-head">
        <span>Position</span>
        <span className="num">Size (USD)</span>
        <span className="num">When</span>
      </div>
      <ul className="book-side trades liq-feed">
        {liquidations.map((l) => {
          const market = markets.find((m) => m.address === l.market);
          const isLong = l.side === Side.Long;
          const mine = l.owner === owner;
          return (
            <li
              key={`${l.owner}-${l.time}-${l.market}`}
              className="book-row"
              title={`${isLong ? 'Long' : 'Short'} liquidated at $${formatUsd(l.price, priceDecimals(l.price))} · collateral $${formatUsd(l.collateral)} · keeper reward $${formatUsd(l.liquidatorReward)}`}
            >
              <span className="book-price">
                {mine && <span className="book-mine" aria-label="Your position" />}
                <span className={isLong ? 'pos' : 'neg'}>{isLong ? 'Long' : 'Short'}</span>{' '}
                <span className="faint">{market?.symbol.replace(/-PERP$/, '') ?? '?'} @ {formatUsd(l.price, priceDecimals(l.price))}</span>
              </span>
              <span className="mono num">{formatUsd(l.sizeUsd, 0)}</span>
              <span className="mono num faint">{ago(now - Number(l.time))}</span>
            </li>
          );
        })}
      </ul>
      <p className="fine left">Positions whose equity fell below maintenance margin, closed by a keeper for a fee. Hover a row for details.</p>
    </>
  );
}
