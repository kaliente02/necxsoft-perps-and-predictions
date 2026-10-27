import { type PerpsState, type PositionInfo, formatUsd, valuePosition } from '../lib/perps';

export function AccountSummary({
  state,
  positions,
  usdcBalance,
  now,
  connected,
}: {
  state: PerpsState;
  positions: PositionInfo[];
  usdcBalance: bigint | undefined;
  now: bigint;
  connected: boolean;
}) {
  let collateral = 0n;
  let equity = 0n;
  let exposure = 0n;
  for (const position of positions) {
    const market = state.markets.find((m) => m.address === position.market.address) ?? position.market;
    const v = valuePosition(position.data, market.data, state.exchange, market.data.price, now);
    collateral += position.data.collateral;
    equity += v.equity > 0n ? v.equity : 0n;
    exposure += position.data.sizeUsd;
  }
  const pnl = equity - collateral;
  const dash = '—';

  return (
    <section className="card account" aria-label="Account">
      <h2 className="card-title">Account</h2>
      <dl className="kv">
        <div><dt>Wallet balance</dt><dd className="mono">{connected && usdcBalance !== undefined ? `${formatUsd(usdcBalance)} USDC` : dash}</dd></div>
        <div><dt>Margin in use</dt><dd className="mono">{connected ? `$${formatUsd(collateral)}` : dash}</dd></div>
        <div><dt>Total exposure</dt><dd className="mono">{connected ? `$${formatUsd(exposure)}` : dash}</dd></div>
        <div>
          <dt>Unrealized PnL</dt>
          <dd className={`mono ${connected && positions.length ? (pnl >= 0n ? 'pos' : 'neg') : ''}`}>
            {connected ? `${pnl >= 0n ? '+' : '−'}$${formatUsd(pnl < 0n ? -pnl : pnl)}` : dash}
          </dd>
        </div>
      </dl>
    </section>
  );
}
