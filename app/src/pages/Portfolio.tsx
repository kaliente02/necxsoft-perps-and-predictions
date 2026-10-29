import type { Address } from '@solana/kit';
import { useFlows, usePredictionPositions, usePredictions, useTokenBalance } from '../hooks';
import { type OrderInfo, type PerpsState, type PositionInfo, formatUsd, poolAum, signedUsd, valuePosition } from '../lib/perps';
import { type Product, type ProductSummary, summarize } from '../lib/portfolio';
import { positionValue } from '../lib/predict';

const PRODUCTS: { product: Product; title: string; href: string; openLabel: string }[] = [
  { product: 'perps', title: 'Perps', href: '#/trade', openLabel: 'Open positions and orders' },
  { product: 'predict', title: 'Predictions', href: '#/predict', openLabel: 'Shares held' },
  { product: 'earn', title: 'Liquidity pool', href: '#/earn', openLabel: 'NLP value' },
];

const tone = (v: bigint) => (v > 0n ? 'pos' : v < 0n ? 'neg' : '');

export function Portfolio({
  state,
  owner,
  positions,
  orders,
  usdcBalance,
  lpSupply,
  now,
}: {
  state: PerpsState;
  owner: Address | null;
  positions: PositionInfo[];
  orders: OrderInfo[];
  usdcBalance: bigint | undefined;
  lpSupply: bigint | undefined;
  now: bigint;
}) {
  const history = useFlows(owner, state.exchange.collateralMint);
  const predictions = usePredictions(state).data ?? [];
  const predictionPositions = usePredictionPositions(owner).data ?? [];
  const lpBalance = useTokenBalance(owner, state.exchange.lpMint);

  if (!owner) {
    return (
      <div className="portfolio">
        <PortfolioHero />
        <div className="empty">
          <strong>Connect your wallet</strong>
          <span className="faint">Your profit and loss across perps, predictions and the liquidity pool will appear here.</span>
        </div>
      </div>
    );
  }

  // What's still open, valued now.
  let perpsOpen = 0n;
  for (const position of positions) {
    const market = state.markets.find((m) => m.address === position.market.address) ?? position.market;
    const { equity } = valuePosition(position.data, market.data, state.exchange, market.data.price, now);
    if (equity > 0n) perpsOpen += equity;
  }
  for (const order of orders) perpsOpen += order.data.collateral; // limit orders escrow collateral
  let predictOpen = 0n;
  for (const p of predictionPositions) {
    const market = predictions.find((m) => m.address === p.data.market);
    if (market) predictOpen += positionValue(market.data, p.data);
  }
  const supply = lpSupply ?? 0n;
  const earnOpen = supply > 0n && lpBalance ? (lpBalance * poolAum(state)) / supply : 0n;
  const open: Record<Product, bigint> = { perps: perpsOpen, predict: predictOpen, earn: earnOpen };

  const flows = history.data?.flows;
  const summaries = flows && Object.fromEntries(PRODUCTS.map(({ product }) => [product, summarize(flows, product, open[product])])) as
    | Record<Product, ProductSummary>
    | undefined;
  const total = summaries ? Object.values(summaries).reduce((sum, s) => sum + s.net, 0n) : null;
  const fees = summaries ? Object.values(summaries).reduce((sum, s) => sum + s.fees, 0n) : null;
  const wins = flows?.reduce((n, f) => n + f.wins, 0) ?? 0;
  const losses = flows?.reduce((n, f) => n + f.losses, 0) ?? 0;

  return (
    <div className="portfolio">
      <PortfolioHero total={total} loading={!history.data && !history.error} />

      {history.error && !history.data ? (
        <div className="empty">
          <strong>Couldn't load your history</strong>
          <span className="faint">The RPC endpoint didn't respond. This page retries automatically.</span>
        </div>
      ) : (
        <>
          <div className="portfolio-grid">
            {PRODUCTS.map(({ product, title, href, openLabel }) => {
              const s = summaries?.[product];
              return (
                <a key={product} href={href} className="card portfolio-card">
                  <span className="eyebrow">{title}</span>
                  {s ? (
                    <span className={`mono big ${tone(s.net)}`}>{signedUsd(s.net)}</span>
                  ) : (
                    <span className="skeleton portfolio-skeleton" />
                  )}
                  <dl className="kv">
                    <div><dt>Paid in</dt><dd className="mono">{s ? `$${formatUsd(s.paidIn)}` : '—'}</dd></div>
                    <div><dt>Received back</dt><dd className="mono">{s ? `$${formatUsd(s.received)}` : '—'}</dd></div>
                    <div><dt>{openLabel}</dt><dd className="mono">${formatUsd(open[product])}</dd></div>
                  </dl>
                </a>
              );
            })}
          </div>

          <dl className="stat-grid">
            <div className="card stat">
              <dt>Closed trades</dt>
              <dd className="mono">
                {wins + losses > 0 ? (
                  <>
                    <span className="pos">{wins} won</span> · <span className="neg">{losses} lost</span>
                  </>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div className="card stat">
              <dt>Win rate</dt>
              <dd className="mono">{wins + losses > 0 ? `${Math.round((wins / (wins + losses)) * 100)}%` : '—'}</dd>
            </div>
            <div className="card stat">
              <dt>Trading fees paid</dt>
              <dd className="mono">{fees !== null ? `$${formatUsd(fees)}` : '—'}</dd>
            </div>
            <div className="card stat">
              <dt>Wallet balance</dt>
              <dd className="mono">{usdcBalance !== undefined ? `$${formatUsd(usdcBalance)}` : '—'}</dd>
            </div>
          </dl>

          <p className="faint small portfolio-note">
            Profit = USDC received back − USDC paid in + the current value of what's still open. Test USDC from the faucet isn't
            counted, and fees are already taken out. A closed trade counts as won when the price moved in your favour.
            {history.data && !history.data.complete && ' Only your most recent 1,000 transactions are included.'}
          </p>
        </>
      )}
    </div>
  );
}

function PortfolioHero({ total = null, loading = false }: { total?: bigint | null; loading?: boolean }) {
  return (
    <section className="earn-hero portfolio-hero">
      <span className="eyebrow">Portfolio</span>
      <h1>Your profit and loss</h1>
      {total !== null ? (
        <span className={`mono portfolio-total ${tone(total)}`}>{signedUsd(total)}</span>
      ) : loading ? (
        <span className="skeleton portfolio-total-skeleton" aria-label="Loading" />
      ) : null}
      <p>All time, across perps, predictions and the liquidity pool, including positions that are still open.</p>
    </section>
  );
}
