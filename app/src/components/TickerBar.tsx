import { useEffect, useRef, useState } from 'react';
import { dayStats, useCandles } from '../lib/candles';
import { BPS, type MarketInfo, type PerpsState, formatUsd, priceDecimals } from '../lib/perps';

const ASSET_NAMES: Record<string, string> = { SOL: 'Solana', BTC: 'Bitcoin', ETH: 'Ethereum' };

export function assetOf(symbol: string) {
  return symbol.replace('-PERP', '');
}

export function AssetIcon({ symbol }: { symbol: string }) {
  const asset = assetOf(symbol);
  return (
    <span className={`asset-icon asset-${asset.toLowerCase()}`} aria-hidden>
      {asset.slice(0, 1)}
    </span>
  );
}

/** Flash up/down when the value changes. */
function useFlash(value: bigint) {
  const previous = useRef(value);
  const [flash, setFlash] = useState<'' | 'up' | 'down'>('');
  useEffect(() => {
    if (value === previous.current) return;
    setFlash(value > previous.current ? 'up' : 'down');
    previous.current = value;
    const id = setTimeout(() => setFlash(''), 700);
    return () => clearTimeout(id);
  }, [value]);
  return flash;
}

function MarketPicker({
  markets,
  market,
  onSelect,
}: {
  markets: MarketInfo[];
  market: MarketInfo;
  onSelect: (address: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="picker" ref={ref}>
      <button className="picker-trigger" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox">
        <AssetIcon symbol={market.symbol} />
        <span className="picker-label">
          <strong>{market.symbol}</strong>
          <span className="muted">{ASSET_NAMES[assetOf(market.symbol)] ?? assetOf(market.symbol)} perpetual</span>
        </span>
        <span className="chevron" aria-hidden>▾</span>
      </button>
      {open && (
        <ul className="menu picker-menu" role="listbox" aria-label="Markets">
          {markets.map((m) => (
            <li key={m.address}>
              <button
                role="option"
                aria-selected={m.address === market.address}
                className={`menu-item ${m.address === market.address ? 'selected' : ''}`}
                onClick={() => {
                  onSelect(m.address);
                  setOpen(false);
                }}
              >
                <AssetIcon symbol={m.symbol} />
                <span className="grow">{m.symbol}</span>
                <span className="mono">${formatUsd(m.data.price, priceDecimals(m.data.price))}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TickerBar({
  state,
  market,
  now,
  onSelect,
}: {
  state: PerpsState;
  market: MarketInfo;
  now: bigint;
  onSelect: (address: string) => void;
}) {
  const { data: day } = useCandles(market.symbol, '1D');
  const stats = dayStats(day);
  const price = market.data.price;
  const priceNum = Number(price) / 1e6;
  const dp = priceDecimals(price);
  const flash = useFlash(price);
  const change = stats ? (priceNum - stats.open) / stats.open : null;

  const age = Number(now - market.data.priceUpdatedAt);
  const stale = age > state.exchange.params.maxPriceAgeSecs;
  const longOi = market.data.longOpenInterest;
  const shortOi = market.data.shortOpenInterest;
  const longShare = longOi + shortOi > 0n ? Number((longOi * BPS) / (longOi + shortOi)) / 100 : 50;
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

  return (
    <section className="card ticker" aria-label="Market overview">
      <MarketPicker markets={state.markets} market={market} onSelect={onSelect} />
      <div className={`ticker-price ${flash}`}>
        <span className="mono big">${formatUsd(price, dp)}</span>
        <span className="eyebrow">Mark price</span>
      </div>
      <dl className="ticker-stats">
        <div>
          <dt>24h change</dt>
          <dd className={change == null ? '' : change >= 0 ? 'pos' : 'neg'}>
            {change == null ? '—' : `${change >= 0 ? '+' : '−'}${(Math.abs(change) * 100).toFixed(2)}%`}
          </dd>
        </div>
        <div>
          <dt>24h high</dt>
          <dd>{stats ? `$${fmt(stats.high)}` : '—'}</dd>
        </div>
        <div>
          <dt>24h low</dt>
          <dd>{stats ? `$${fmt(stats.low)}` : '—'}</dd>
        </div>
        <div>
          <dt>Open interest (L / S)</dt>
          <dd>
            ${formatUsd(longOi, 0)} <span className="faint">/</span> ${formatUsd(shortOi, 0)}
            <span className="ratio" role="img" aria-label={`${longShare.toFixed(0)}% long, ${(100 - longShare).toFixed(0)}% short`}>
              <span className="ratio-long" style={{ width: `${longShare}%` }} />
              <span className="ratio-short" />
            </span>
          </dd>
        </div>
        <div>
          <dt>Borrow rate</dt>
          <dd>{(Number(market.data.hourlyBorrowRate) / 1e7).toFixed(4)}% / h</dd>
        </div>
        <div>
          <dt>Oracle</dt>
          <dd className={stale ? 'neg' : ''}>
            <span className={`status-dot ${stale ? 'down' : 'ok'}`} aria-hidden />
            {stale ? `Stale · ${age}s` : `Live · ${Math.max(age, 0)}s`}
          </dd>
        </div>
      </dl>
    </section>
  );
}
