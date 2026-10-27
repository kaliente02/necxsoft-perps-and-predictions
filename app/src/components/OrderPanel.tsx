import { useEffect, useState } from 'react';
import {
  BASE_SCALE,
  BPS,
  type MarketInfo,
  OrderKind,
  type PerpsState,
  type PositionInfo,
  Side,
  formatUsd,
  increasePositionIxs,
  liquidationPrice,
  parseUsd,
  placeOrderIx,
  priceDecimals,
  signedUsd,
  triggerProblem,
} from '../lib/perps';
import { useTx } from '../tx';
import { Modal } from './Modal';
import { assetOf } from './TickerBar';

const SLIPPAGES = [10n, 50n, 100n]; // bps
const PRESETS = [2, 5, 10, 25, 50];

type OrderType = 'market' | 'limit';

/** Price input for limit and TP/SL triggers, in USD. */
function PriceField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">
        <span>{label}</span>
        {hint && <span className="faint">{hint}</span>}
      </span>
      <div className="input">
        <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.00" aria-label={label} />
        <span className="unit">USD</span>
      </div>
    </label>
  );
}

export function OrderPanel({
  state,
  market,
  positions,
  usdcBalance,
  connected,
}: {
  state: PerpsState;
  market: MarketInfo;
  positions: PositionInfo[];
  usdcBalance: bigint | undefined;
  connected: boolean;
}) {
  const { run, isRunning } = useTx();
  const [side, setSide] = useState<Side>(Side.Long);
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [amount, setAmount] = useState('100');
  const [leverage, setLeverage] = useState(5);
  const [slippageBps, setSlippageBps] = useState(50n);
  const [limitInput, setLimitInput] = useState('');
  const [tpslOn, setTpslOn] = useState(false);
  const [tpInput, setTpInput] = useState('');
  const [slInput, setSlInput] = useState('');
  const [reviewing, setReviewing] = useState(false);

  const params = state.exchange.params;
  const price = market.data.price;
  const dp = priceDecimals(price);
  const isLong = side === Side.Long;
  const isLimit = orderType === 'limit';

  // Start trigger inputs at sensible levels whenever the market or side changes.
  useEffect(() => {
    const pct = (bps: bigint) => formatUsd((price * bps) / BPS, dp).replace(/,/g, '');
    setLimitInput(pct(isLong ? 9_900n : 10_100n));
    setTpInput('');
    setSlInput('');
  }, [market.address, side]);

  const limitPrice = parseUsd(limitInput) ?? 0n;
  const entryPrice = isLimit ? limitPrice : price;
  const tpPrice = tpslOn && !isLimit ? parseUsd(tpInput) : null;
  const slPrice = tpslOn && !isLimit ? parseUsd(slInput) : null;

  const collateral = parseUsd(amount) ?? 0n;
  const size = (collateral * BigInt(Math.round(leverage * 100))) / 100n;
  const openFee = (size * BigInt(params.tradeFeeBps)) / BPS;
  const maintenance = (size * BigInt(params.maintenanceMarginBps)) / BPS;
  const base = entryPrice > 0n ? (size * BASE_SCALE) / entryPrice : 0n;
  const liqPrice = liquidationPrice(side, size, base, collateral - openFee * 2n, maintenance);
  const priceLimit = isLong ? (price * (BPS + slippageBps)) / BPS : (price * (BPS - slippageBps)) / BPS;
  const existing = positions.find((p) => p.market.address === market.address && p.data.side === side);
  const sideOi = side === Side.Long ? market.data.longOpenInterest : market.data.shortOpenInterest;
  const maxPoolOi = (state.exchange.poolBalance * BigInt(params.maxUtilizationBps)) / BPS;
  const available = maxPoolOi > state.exchange.totalOpenInterest ? maxPoolOi - state.exchange.totalOpenInterest : 0n;
  const pnlAtTrigger = (trigger: bigint) => {
    const value = (base * trigger) / BASE_SCALE;
    return (isLong ? value - size : size - value) - openFee * 2n;
  };

  let problem: string | null = null;
  if (!connected) problem = 'Connect wallet to trade';
  else if (state.exchange.paused) problem = 'Trading paused';
  else if (collateral <= 0n) problem = 'Enter an amount';
  else if (usdcBalance !== undefined && collateral > usdcBalance) problem = 'Insufficient USDC balance';
  else if (!existing && collateral - openFee < params.minCollateral)
    problem = `Minimum collateral is ${formatUsd(params.minCollateral, 0)} USDC`;
  else if (isLimit) problem = triggerProblem(OrderKind.Limit, side, limitPrice, price);
  else if (sideOi + size > market.data.maxOpenInterest) problem = 'Market open-interest cap reached';
  else if (size > available) problem = 'Exceeds available liquidity';
  if (!problem && tpPrice) problem = triggerProblem(OrderKind.TakeProfit, side, tpPrice, price);
  if (!problem && slPrice) problem = triggerProblem(OrderKind.StopLoss, side, slPrice, price);
  if (!problem && slPrice && liqPrice > 0n && (isLong ? slPrice <= liqPrice : slPrice >= liqPrice))
    problem = 'Stop loss is past the liquidation price';

  const asset = assetOf(market.symbol);
  const action = `${isLimit ? 'Limit ' : ''}${isLong ? 'Long' : 'Short'} ${asset}`;
  const presets = PRESETS.filter((v) => v <= params.maxLeverage);

  function submit() {
    setReviewing(false);
    if (isLimit) {
      run(`${action} @ $${formatUsd(limitPrice, dp)}`, async (owner) => [
        await placeOrderIx({
          state,
          owner,
          market: market.address,
          side,
          kind: OrderKind.Limit,
          triggerPrice: limitPrice,
          sizeUsd: size,
          collateral,
        }),
      ]);
      return;
    }
    run(`${action} · ${leverage.toFixed(1)}x`, async (owner) => {
      const triggers = [
        [OrderKind.TakeProfit, tpPrice],
        [OrderKind.StopLoss, slPrice],
      ] as const;
      return [
        ...(await increasePositionIxs({ state, owner, market: market.address, side, collateral, sizeUsd: size, priceLimit })),
        ...(await Promise.all(
          triggers
            .filter(([, trigger]) => trigger)
            .map(([kind, trigger]) =>
              placeOrderIx({ state, owner, market: market.address, side, kind, triggerPrice: trigger!, sizeUsd: 0n, collateral: 0n }),
            ),
        )),
      ];
    });
  }

  const details = (
    <dl className="kv">
      <div><dt>{isLimit ? 'Limit price' : 'Entry price'}</dt><dd className="mono">{entryPrice > 0n ? `$${formatUsd(entryPrice, dp)}` : '—'}</dd></div>
      {!isLimit && <div><dt>Price limit ({Number(slippageBps) / 100}%)</dt><dd className="mono">${formatUsd(priceLimit, dp)}</dd></div>}
      <div><dt>Est. liquidation price</dt><dd className="mono warn">{liqPrice > 0n ? `$${formatUsd(liqPrice, dp)}` : '—'}</dd></div>
      {tpPrice ? <div><dt>Take profit</dt><dd className="mono pos">${formatUsd(tpPrice, dp)} · {signedUsd(pnlAtTrigger(tpPrice))}</dd></div> : null}
      {slPrice ? <div><dt>Stop loss</dt><dd className="mono neg">${formatUsd(slPrice, dp)} · {signedUsd(pnlAtTrigger(slPrice))}</dd></div> : null}
      <div><dt>Open fee ({params.tradeFeeBps / 100}%)</dt><dd className="mono">${formatUsd(openFee)}</dd></div>
      <div><dt>Borrow fee</dt><dd className="mono">{(Number(market.data.hourlyBorrowRate) / 1e7).toFixed(4)}% / h</dd></div>
    </dl>
  );

  return (
    <section className="card order" aria-label="Order ticket">
      <div className={`side-toggle ${isLong ? 'is-long' : 'is-short'}`} role="tablist" aria-label="Direction">
        <button role="tab" aria-selected={isLong} className={isLong ? 'active' : ''} onClick={() => setSide(Side.Long)}>
          Long
        </button>
        <button role="tab" aria-selected={!isLong} className={!isLong ? 'active' : ''} onClick={() => setSide(Side.Short)}>
          Short
        </button>
        <span className="side-indicator" aria-hidden />
      </div>

      <div className="order-type">
        <div className="segmented small" role="tablist" aria-label="Order type">
          {(['market', 'limit'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={orderType === t} className={orderType === t ? 'active' : ''} onClick={() => setOrderType(t)}>
              {t === 'market' ? 'Market' : 'Limit'}
            </button>
          ))}
        </div>
        <span className="faint">
          {isLimit
            ? `Opens when the price ${isLong ? 'falls to' : 'rises to'} your limit`
            : 'Executes now at the oracle price'}
        </span>
      </div>

      {isLimit && (
        <PriceField
          label="Limit price"
          value={limitInput}
          onChange={setLimitInput}
          hint={`Mark $${formatUsd(price, dp)}`}
        />
      )}

      <label className="field">
        <span className="field-label">
          <span>Collateral</span>
          {usdcBalance !== undefined && (
            <button type="button" className="link" onClick={() => setAmount(formatUsd(usdcBalance).replace(/,/g, ''))}>
              Max {formatUsd(usdcBalance)}
            </button>
          )}
        </span>
        <div className="input">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-label="Collateral in USDC" />
          <span className="unit">USDC</span>
        </div>
      </label>

      <div className="field">
        <span className="field-label">
          <span>Leverage</span>
          <span className="leverage-value mono">{leverage.toFixed(1)}×</span>
        </span>
        <input
          type="range"
          min={1.1}
          max={params.maxLeverage}
          step={0.1}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
          className="slider"
          aria-label="Leverage"
          style={{ ['--fill' as string]: `${((leverage - 1.1) / (params.maxLeverage - 1.1)) * 100}%` }}
        />
        <div className="presets">
          {presets.map((v) => (
            <button key={v} type="button" className={`chip ${leverage === v ? 'active' : ''}`} onClick={() => setLeverage(v)}>
              {v}×
            </button>
          ))}
        </div>
      </div>

      <div className="size-row">
        <span className="faint">Position size</span>
        <span className="mono strong">${formatUsd(size)}</span>
      </div>

      {!isLimit && (
        <div className="tpsl">
          <label className="check">
            <input type="checkbox" checked={tpslOn} onChange={(e) => setTpslOn(e.target.checked)} />
            <span>Take profit / Stop loss</span>
          </label>
          {tpslOn && (
            <div className="tpsl-grid">
              <PriceField label="Take profit" value={tpInput} onChange={setTpInput} hint={isLong ? 'above mark' : 'below mark'} />
              <PriceField label="Stop loss" value={slInput} onChange={setSlInput} hint={isLong ? 'below mark' : 'above mark'} />
            </div>
          )}
        </div>
      )}

      {details}

      {!isLimit && (
        <div className="slippage">
          <span className="faint">Slippage tolerance</span>
          <div className="segmented small">
            {SLIPPAGES.map((s) => (
              <button key={s} type="button" className={s === slippageBps ? 'active' : ''} onClick={() => setSlippageBps(s)}>
                {Number(s) / 100}%
              </button>
            ))}
          </div>
        </div>
      )}

      {existing && <p className="note">This adds to your open {isLong ? 'long' : 'short'} of ${formatUsd(existing.data.sizeUsd)}.</p>}
      {isLimit && (
        <p className="note">Your collateral is held by the exchange until the order fills or you cancel it from the Orders tab.</p>
      )}

      <button
        className={`btn btn-block ${problem ? 'btn-secondary' : isLong ? 'btn-long' : 'btn-short'}`}
        disabled={problem != null || isRunning}
        onClick={() => setReviewing(true)}
      >
        {problem ?? (isRunning ? 'Waiting for wallet…' : action)}
      </button>

      {reviewing && (
        <Modal title={isLimit ? 'Review limit order' : 'Review order'} onClose={() => setReviewing(false)}>
          <div className="review-hero">
            <span className={`badge ${isLong ? 'long' : 'short'}`}>{isLong ? 'Long' : 'Short'}</span>
            <span className="review-size mono">${formatUsd(size)}</span>
            <span className="faint">{market.symbol} · {leverage.toFixed(1)}× · {formatUsd(collateral)} USDC collateral</span>
          </div>
          {details}
          <p className="fine">
            {isLimit
              ? `The keeper opens this position at the oracle price once ${asset} trades at or ${isLong ? 'below' : 'above'} $${formatUsd(limitPrice, dp)}. Pool liquidity and risk limits are checked when it fills.`
              : "You'll be asked to approve this transaction in your wallet. If the oracle price moves beyond your price limit before execution, the order is rejected and nothing is charged."}
          </p>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={() => setReviewing(false)}>Cancel</button>
            <button className={`btn ${isLong ? 'btn-long' : 'btn-short'}`} onClick={submit}>
              Confirm {action}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
