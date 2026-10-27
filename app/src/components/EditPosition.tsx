import { type ReactNode, useState } from 'react';
import {
  BPS,
  type OrderInfo,
  OrderKind,
  type PerpsState,
  type PositionInfo,
  Side,
  cancelOrderIx,
  decreasePositionIxs,
  formatUsd,
  increasePositionIxs,
  isAttached,
  orderKindLabel,
  parseUsd,
  placeOrderIx,
  pnlAt,
  priceDecimals,
  signedUsd,
  triggerProblem,
  valuePosition,
} from '../lib/perps';
import { useTx } from '../tx';
import { Modal } from './Modal';

type Tab = 'collateral' | 'close' | 'tpsl';
const SLIPPAGE_BPS = 100n;
const PARTS = [25n, 50n, 75n];

export function EditPosition({
  state,
  position,
  orders,
  now,
  usdcBalance,
  onClose,
}: {
  state: PerpsState;
  position: PositionInfo;
  orders: OrderInfo[];
  now: bigint;
  usdcBalance: bigint | undefined;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('collateral');
  const market = state.markets.find((m) => m.address === position.market.address) ?? position.market;
  const p = position.data;
  const isLong = p.side === Side.Long;
  const dp = priceDecimals(market.data.price);

  return (
    <Modal title={`${market.symbol} ${isLong ? 'long' : 'short'}`} onClose={onClose}>
      <div className="stack">
      <div className="segmented full" role="tablist" aria-label="Edit position">
        {(
          [
            ['collateral', 'Collateral'],
            ['close', 'Close part'],
            ['tpsl', 'TP / SL'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <dl className="kv compact">
        <div><dt>Size</dt><dd className="mono">${formatUsd(p.sizeUsd)}</dd></div>
        <div><dt>Collateral</dt><dd className="mono">${formatUsd(p.collateral)}</dd></div>
        <div><dt>Mark price</dt><dd className="mono">${formatUsd(market.data.price, dp)}</dd></div>
      </dl>
      {tab === 'collateral' && (
        <CollateralForm state={state} position={position} now={now} usdcBalance={usdcBalance} onDone={onClose} />
      )}
      {tab === 'close' && <PartialCloseForm state={state} position={position} now={now} onDone={onClose} />}
      {tab === 'tpsl' && <TriggerForm state={state} position={position} orders={orders} onDone={onClose} />}
      </div>
    </Modal>
  );
}

function AmountInput({ label, value, onChange, unit, hint }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  hint?: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        <span>{label}</span>
        {hint}
      </span>
      <div className="input">
        <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.00" aria-label={label} />
        <span className="unit">{unit}</span>
      </div>
    </label>
  );
}

function CollateralForm({ state, position, now, usdcBalance, onDone }: {
  state: PerpsState;
  position: PositionInfo;
  now: bigint;
  usdcBalance: bigint | undefined;
  onDone: () => void;
}) {
  const { run, isRunning } = useTx();
  const [adding, setAdding] = useState(true);
  const [amount, setAmount] = useState('');
  const params = state.exchange.params;
  const market = state.markets.find((m) => m.address === position.market.address) ?? position.market;
  const p = position.data;
  const v = valuePosition(p, market.data, state.exchange, market.data.price, now);
  const value = parseUsd(amount) ?? 0n;
  // Borrow fees are settled out of collateral by either action.
  const newCollateral = adding ? p.collateral + value - v.borrowFee : p.collateral - value - v.borrowFee;
  const newLeverage = newCollateral > 0n ? Number(p.sizeUsd) / Number(newCollateral) : Infinity;
  const newEquity = newCollateral + v.pnl - v.closeFee;
  // Keep a 1% buffer over every on-chain limit so price ticks between now and execution don't fail the withdrawal.
  const maxRemovable = (() => {
    const byLeverage = p.collateral - v.borrowFee - (p.sizeUsd * 101n) / (100n * BigInt(params.maxLeverage));
    const byMargin = p.collateral - v.borrowFee + v.pnl - v.closeFee - (v.maintenanceMargin * 101n) / 100n;
    const byMinimum = p.collateral - v.borrowFee - params.minCollateral;
    const max = [byLeverage, byMargin, byMinimum].reduce((a, b) => (a < b ? a : b));
    return max > 0n ? max : 0n;
  })();

  let problem: string | null = null;
  if (value <= 0n) problem = 'Enter an amount';
  else if (adding && usdcBalance !== undefined && value > usdcBalance) problem = 'Insufficient USDC balance';
  else if (!adding && value > maxRemovable) problem = `You can remove up to ${formatUsd(maxRemovable)} USDC`;
  else if (!adding && newEquity <= v.maintenanceMargin) problem = 'Would put the position below maintenance margin';

  function submit() {
    onDone();
    run(`${adding ? 'Add' : 'Remove'} ${formatUsd(value)} USDC collateral`, (owner) =>
      adding
        ? increasePositionIxs({ state, owner, market: market.address, side: p.side, collateral: value, sizeUsd: 0n, priceLimit: 0n })
        : decreasePositionIxs({ state, owner, position, sizeUsd: 0n, collateralOut: value, priceLimit: 0n }),
    );
  }

  return (
    <>
      <div className="segmented small" role="tablist" aria-label="Direction">
        <button role="tab" aria-selected={adding} className={adding ? 'active' : ''} onClick={() => setAdding(true)}>Add</button>
        <button role="tab" aria-selected={!adding} className={!adding ? 'active' : ''} onClick={() => setAdding(false)}>Remove</button>
      </div>
      <AmountInput
        label={adding ? 'Add collateral' : 'Remove collateral'}
        value={amount}
        onChange={setAmount}
        unit="USDC"
        hint={
          adding
            ? usdcBalance !== undefined && (
                <button type="button" className="link" onClick={() => setAmount(formatUsd(usdcBalance).replace(/,/g, ''))}>
                  Max {formatUsd(usdcBalance)}
                </button>
              )
            : <button type="button" className="link" onClick={() => setAmount(formatUsd(maxRemovable).replace(/,/g, ''))}>
                Max {formatUsd(maxRemovable)}
              </button>
        }
      />
      <dl className="kv">
        <div><dt>Leverage</dt><dd className="mono">{(Number(p.sizeUsd) / Number(p.collateral || 1n)).toFixed(2)}× → {value > 0n && Number.isFinite(newLeverage) ? `${newLeverage.toFixed(2)}×` : '—'}</dd></div>
        <div><dt>Collateral after</dt><dd className="mono">{value > 0n ? `$${formatUsd(newCollateral > 0n ? newCollateral : 0n)}` : '—'}</dd></div>
        {v.borrowFee > 0n && <div><dt>Borrow fee settled</dt><dd className="mono">−${formatUsd(v.borrowFee)}</dd></div>}
      </dl>
      <div className="modal-actions single">
        <button className="btn btn-primary btn-block" disabled={problem != null || isRunning} onClick={submit}>
          {problem ?? `${adding ? 'Add' : 'Remove'} collateral`}
        </button>
      </div>
    </>
  );
}

function PartialCloseForm({ state, position, now, onDone }: {
  state: PerpsState;
  position: PositionInfo;
  now: bigint;
  onDone: () => void;
}) {
  const { run, isRunning } = useTx();
  const [amount, setAmount] = useState('');
  const params = state.exchange.params;
  const market = state.markets.find((m) => m.address === position.market.address) ?? position.market;
  const p = position.data;
  const price = market.data.price;
  const dp = priceDecimals(price);
  const v = valuePosition(p, market.data, state.exchange, price, now);
  const size = parseUsd(amount) ?? 0n;
  const isLong = p.side === Side.Long;
  const priceLimit = isLong ? (price * (BPS - SLIPPAGE_BPS)) / BPS : (price * (BPS + SLIPPAGE_BPS)) / BPS;

  // Mirrors apply_decrease: proportional collateral out, profit paid on top, losses kept by the position.
  const collateralOut = p.sizeUsd > 0n ? (p.collateral * size) / p.sizeUsd : 0n;
  const pnl = pnlAt(p, size, price);
  const fees = v.borrowFee + (size * BigInt(params.tradeFeeBps)) / BPS;
  const realized = pnl - fees;
  const receive = collateralOut + (realized > 0n ? realized : 0n);
  const remainingCollateral = p.collateral - collateralOut + (realized < 0n ? realized : 0n);

  let problem: string | null = null;
  if (size <= 0n) problem = 'Enter a size';
  else if (size >= p.sizeUsd) problem = 'Use Close to close the whole position';
  else if (remainingCollateral < params.minCollateral) problem = 'Remaining collateral would be below the minimum';

  function submit() {
    onDone();
    run(`Close $${formatUsd(size)} of ${market.symbol} ${isLong ? 'long' : 'short'}`, (owner) =>
      decreasePositionIxs({ state, owner, position, sizeUsd: size, collateralOut, priceLimit }),
    );
  }

  return (
    <>
      <AmountInput label="Size to close" value={amount} onChange={setAmount} unit="USD" />
      <div className="presets">
        {PARTS.map((pct) => (
          <button
            key={pct}
            type="button"
            className="chip"
            onClick={() => setAmount(formatUsd((p.sizeUsd * pct) / 100n).replace(/,/g, ''))}
          >
            {pct.toString()}%
          </button>
        ))}
      </div>
      <dl className="kv">
        <div><dt>Price PnL on closed part</dt><dd className={`mono ${pnl >= 0n ? 'pos' : 'neg'}`}>{size > 0n ? signedUsd(pnl) : '—'}</dd></div>
        <div><dt>Fees</dt><dd className="mono">{size > 0n ? `−$${formatUsd(fees)}` : '—'}</dd></div>
        <div><dt>Price limit (1%)</dt><dd className="mono">${formatUsd(priceLimit, dp)}</dd></div>
        <div><dt>You receive</dt><dd className="mono strong">{size > 0n ? `$${formatUsd(receive)}` : '—'}</dd></div>
        <div><dt>Remaining size</dt><dd className="mono">${formatUsd(p.sizeUsd - (size < p.sizeUsd ? size : 0n))}</dd></div>
      </dl>
      <div className="modal-actions single">
        <button className="btn btn-primary btn-block" disabled={problem != null || isRunning} onClick={submit}>
          {problem ?? 'Close part of position'}
        </button>
      </div>
    </>
  );
}

function TriggerForm({ state, position, orders, onDone }: {
  state: PerpsState;
  position: PositionInfo;
  orders: OrderInfo[];
  onDone: () => void;
}) {
  const { run, isRunning } = useTx();
  const [kind, setKind] = useState<OrderKind>(OrderKind.TakeProfit);
  const [trigger, setTrigger] = useState('');
  const [part, setPart] = useState(100n);
  const market = state.markets.find((m) => m.address === position.market.address) ?? position.market;
  const p = position.data;
  const price = market.data.price;
  const dp = priceDecimals(price);
  const isLong = p.side === Side.Long;
  const triggerPrice = parseUsd(trigger) ?? 0n;
  const size = (p.sizeUsd * part) / 100n;
  const attached = orders.filter((o) => isAttached(o, position));
  const estimate = pnlAt(p, size, triggerPrice) - (size * BigInt(state.exchange.params.tradeFeeBps)) / BPS;
  const problem = triggerProblem(kind, p.side, triggerPrice, price);

  function submit() {
    onDone();
    run(`${orderKindLabel(kind)} at $${formatUsd(triggerPrice, dp)}`, async (owner) => [
      await placeOrderIx({
        state,
        owner,
        market: market.address,
        side: p.side,
        kind,
        triggerPrice,
        sizeUsd: part === 100n ? 0n : size,
        collateral: 0n,
      }),
    ]);
  }

  return (
    <>
      {attached.length > 0 && (
        <ul className="order-list">
          {attached.map((o) => (
            <li key={o.address}>
              <span className={o.data.kind === OrderKind.TakeProfit ? 'pos' : 'neg'}>{orderKindLabel(o.data.kind)}</span>
              <span className="mono">${formatUsd(o.data.triggerPrice, dp)}</span>
              <span className="faint">{o.data.sizeUsd === 0n ? 'Entire position' : `$${formatUsd(o.data.sizeUsd)}`}</span>
              <button
                className="btn btn-secondary btn-small"
                disabled={isRunning}
                onClick={() => run(`Cancel ${orderKindLabel(o.data.kind).toLowerCase()}`, async (owner) => [await cancelOrderIx(state, owner, o)])}
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="segmented small" role="tablist" aria-label="Trigger type">
        {[OrderKind.TakeProfit, OrderKind.StopLoss].map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
            {orderKindLabel(k)}
          </button>
        ))}
      </div>
      <AmountInput
        label="Trigger price"
        value={trigger}
        onChange={setTrigger}
        unit="USD"
        hint={<span className="faint">{(kind === OrderKind.TakeProfit) === isLong ? 'above' : 'below'} ${formatUsd(price, dp)}</span>}
      />
      <div className="field">
        <span className="field-label"><span>Amount to close</span><span className="mono">{part.toString()}%</span></span>
        <div className="presets">
          {[...PARTS, 100n].map((pct) => (
            <button key={pct} type="button" className={`chip ${part === pct ? 'active' : ''}`} onClick={() => setPart(pct)}>
              {pct.toString()}%
            </button>
          ))}
        </div>
      </div>
      <dl className="kv">
        <div><dt>Est. PnL at trigger</dt><dd className={`mono ${estimate >= 0n ? 'pos' : 'neg'}`}>{triggerPrice > 0n ? signedUsd(estimate) : '—'}</dd></div>
      </dl>
      <p className="fine">The keeper closes {part === 100n ? 'the position' : `${part}% of the position`} at the oracle price once it reaches your trigger.</p>
      <div className="modal-actions single">
        <button className="btn btn-primary btn-block" disabled={problem != null || isRunning} onClick={submit}>
          {problem ?? `Set ${orderKindLabel(kind).toLowerCase()}`}
        </button>
      </div>
    </>
  );
}
