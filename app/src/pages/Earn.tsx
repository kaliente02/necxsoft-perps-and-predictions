import { useState } from 'react';
import type { Address } from '@solana/kit';
import { BPS, USD, type PerpsState, formatUsd, liquidityIxs, parseUsd, poolAum } from '../lib/perps';
import { useTokenBalance } from '../hooks';
import { useTx } from '../tx';

const SLIPPAGE_BPS = 50n;

export function Earn({
  state,
  owner,
  usdcBalance,
  lpSupply,
}: {
  state: PerpsState;
  owner: Address | null;
  usdcBalance: bigint | undefined;
  lpSupply: bigint | undefined;
}) {
  const { run, isRunning } = useTx();
  const [deposit, setDeposit] = useState(true);
  const [amount, setAmount] = useState('');
  const lpBalance = useTokenBalance(owner, state.exchange.lpMint);

  const params = state.exchange.params;
  const aum = poolAum(state);
  const supply = lpSupply ?? 0n;
  const lpPrice = supply > 0n ? (aum * USD) / supply : USD;
  const utilization = state.exchange.poolBalance > 0n
    ? Number((state.exchange.totalOpenInterest * 10_000n) / state.exchange.poolBalance) / 100
    : 0;
  const utilizationCap = params.maxUtilizationBps / 100;

  const value = parseUsd(amount) ?? 0n;
  const expected = deposit
    ? supply > 0n && aum > 0n ? (value * supply) / aum : value
    : supply > 0n ? (value * aum) / supply : 0n;
  const minOut = (expected * (BPS - SLIPPAGE_BPS)) / BPS;
  const balance = deposit ? usdcBalance : lpBalance;
  const position = lpBalance ? (lpBalance * lpPrice) / USD : 0n;
  const share = supply > 0n && lpBalance ? Number((lpBalance * 1_000_000n) / supply) / 10_000 : 0;

  let problem: string | null = null;
  if (!owner) problem = 'Connect wallet';
  else if (value <= 0n) problem = 'Enter an amount';
  else if (balance !== undefined && value > balance) problem = `Insufficient ${deposit ? 'USDC' : 'NLP'} balance`;

  return (
    <div className="earn">
      <section className="earn-hero">
        <span className="eyebrow">Necxsoft Liquidity Pool</span>
        <h1>Earn from every trade on Necxsoft Perps</h1>
        <p>
          Deposit USDC to mint NLP. The pool is the counterparty to every position and collects all trading and borrow fees,
          plus trader losses.
        </p>
      </section>

      <div className="earn-grid">
        <div className="earn-main">
          <dl className="stat-grid">
            <div className="card stat">
              <dt>Total value locked</dt>
              <dd className="mono">${formatUsd(aum)}</dd>
            </div>
            <div className="card stat">
              <dt>NLP price</dt>
              <dd className="mono">${formatUsd(lpPrice, 4)}</dd>
            </div>
            <div className="card stat">
              <dt>Open interest</dt>
              <dd className="mono">${formatUsd(state.exchange.totalOpenInterest)}</dd>
            </div>
            <div className="card stat">
              <dt>Utilization</dt>
              <dd className="mono">
                {utilization.toFixed(1)}%<span className="faint small"> / {utilizationCap}% cap</span>
              </dd>
              <div className="meter" role="meter" aria-valuenow={utilization} aria-valuemin={0} aria-valuemax={utilizationCap} aria-label="Pool utilization">
                <span style={{ width: `${Math.min(100, (utilization / utilizationCap) * 100)}%` }} />
              </div>
            </div>
          </dl>

          <section className="card">
            <h2 className="card-title">How the pool earns</h2>
            <ol className="steps">
              <li>
                <strong>Trading fees</strong>
                <span className="faint">{params.tradeFeeBps / 100}% of position size on every open and close.</span>
              </li>
              <li>
                <strong>Borrow fees</strong>
                <span className="faint">An hourly fee on open positions, accrued per market.</span>
              </li>
              <li>
                <strong>Counterparty PnL</strong>
                <span className="faint">The pool gains when traders lose and pays out when they win. Pool value moves with trader PnL.</span>
              </li>
            </ol>
          </section>

          <section className="card risk">
            <h2 className="card-title">Risks</h2>
            <p className="faint">
              NLP value can fall if traders are net profitable. Withdrawals are limited while liquidity backs open positions
              (utilization above {utilizationCap}%). Smart contracts and price oracles carry technical risk.
            </p>
          </section>
        </div>

        <aside className="card lp-form">
          <div className="lp-position">
            <span className="eyebrow">Your position</span>
            <span className="mono big">${formatUsd(position)}</span>
            <span className="faint">
              {lpBalance !== undefined ? `${formatUsd(lpBalance)} NLP · ${share.toFixed(2)}% of pool` : 'Connect a wallet to view'}
            </span>
          </div>

          <div className="segmented full" role="tablist">
            <button role="tab" aria-selected={deposit} className={deposit ? 'active' : ''} onClick={() => setDeposit(true)}>Deposit</button>
            <button role="tab" aria-selected={!deposit} className={!deposit ? 'active' : ''} onClick={() => setDeposit(false)}>Withdraw</button>
          </div>

          <label className="field">
            <span className="field-label">
              <span>{deposit ? 'You deposit' : 'You burn'}</span>
              {balance !== undefined && (
                <button type="button" className="link" onClick={() => setAmount(formatUsd(balance).replace(/,/g, ''))}>
                  Max {formatUsd(balance)}
                </button>
              )}
            </span>
            <div className="input">
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-label="Amount" />
              <span className="unit">{deposit ? 'USDC' : 'NLP'}</span>
            </div>
          </label>

          <dl className="kv">
            <div><dt>You receive (est.)</dt><dd className="mono">{formatUsd(expected)} {deposit ? 'NLP' : 'USDC'}</dd></div>
            <div><dt>Minimum received</dt><dd className="mono">{formatUsd(minOut)} {deposit ? 'NLP' : 'USDC'}</dd></div>
            <div><dt>Deposit / withdraw fee</dt><dd className="mono">None</dd></div>
          </dl>

          <button
            className={`btn btn-block ${problem ? 'btn-secondary' : 'btn-primary'}`}
            disabled={problem != null || isRunning}
            onClick={() =>
              run(deposit ? 'Deposit liquidity' : 'Withdraw liquidity', (signer) =>
                liquidityIxs({ state, owner: signer, deposit, amount: value, minOut }),
              )
            }
          >
            {problem ?? (isRunning ? 'Waiting for wallet…' : deposit ? 'Deposit USDC' : 'Withdraw USDC')}
          </button>
        </aside>
      </div>
    </div>
  );
}
