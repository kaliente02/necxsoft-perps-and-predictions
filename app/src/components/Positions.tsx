import { useState } from 'react';
import {
  BPS,
  type HistoryItem,
  type OrderInfo,
  OrderKind,
  type PerpsState,
  type PositionInfo,
  Side,
  cancelOrderIx,
  closePositionIxs,
  formatUsd,
  isAttached,
  opensPosition,
  orderKindLabel,
  priceDecimals,
  signedUsd,
  valuePosition,
} from '../lib/perps';
import { explorerTxUrl } from '../client';
import { useTx } from '../tx';
import { EditPosition } from './EditPosition';
import { Modal } from './Modal';
import { type PnlCardData, PnlCardModal } from './PnlCard';
import { AssetIcon } from './TickerBar';

const CLOSE_SLIPPAGE_BPS = 100n;

type Tab = 'positions' | 'orders' | 'history';

export function Positions({
  state,
  positions,
  orders,
  history,
  historyLoading,
  now,
  connected,
  usdcBalance,
}: {
  state: PerpsState;
  positions: PositionInfo[];
  orders: OrderInfo[];
  history: HistoryItem[];
  historyLoading: boolean;
  now: bigint;
  connected: boolean;
  usdcBalance: bigint | undefined;
}) {
  const { run, isRunning } = useTx();
  const [tab, setTab] = useState<Tab>('positions');
  const [closing, setClosing] = useState<PositionInfo | null>(null);
  const [editing, setEditing] = useState<PositionInfo | null>(null);
  const [sharing, setSharing] = useState<PnlCardData | null>(null);

  const rows = positions.map((position) => {
    // Use the latest market snapshot so marks stay fresh.
    const market = state.markets.find((m) => m.address === position.market.address) ?? position.market;
    const price = market.data.price;
    const v = valuePosition(position.data, market.data, state.exchange, price, now);
    return { position, market, price, v, net: v.equity - position.data.collateral };
  });
  const closingRow = closing && rows.find((r) => r.position.address === closing.address);
  const editingPosition = editing && positions.find((p) => p.address === editing.address);
  const totalNet = rows.reduce((a, r) => a + r.net, 0n);

  const tabs: [Tab, string, number | null][] = [
    ['positions', 'Positions', positions.length || null],
    ['orders', 'Orders', orders.length || null],
    ['history', 'History', null],
  ];

  let body;
  if (!connected) {
    body = (
      <div className="empty">
        <strong>Connect your wallet</strong>
        <span className="faint">Your positions, orders and trade history will appear here.</span>
      </div>
    );
  } else if (tab === 'positions') {
    body =
      rows.length === 0 ? (
        <div className="empty">
          <strong>No open positions</strong>
          <span className="faint">Choose a market, set your leverage and open a long or short.</span>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Market</th>
                <th className="num">Size</th>
                <th className="num">Collateral</th>
                <th className="num">Entry / Mark</th>
                <th className="num">Liq. price</th>
                <th className="num">TP / SL</th>
                <th className="num">PnL</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ position, market, price, v, net }) => {
                const p = position.data;
                const isLong = p.side === Side.Long;
                const dp = priceDecimals(price);
                const leverage = Number(p.sizeUsd) / Number(p.collateral || 1n);
                const roi = p.collateral ? (Number(net) / Number(p.collateral)) * 100 : 0;
                const attached = orders.filter((o) => isAttached(o, position));
                const tp = attached.find((o) => o.data.kind === OrderKind.TakeProfit);
                const sl = attached.find((o) => o.data.kind === OrderKind.StopLoss);
                return (
                  <tr key={position.address}>
                    <td>
                      <div className="market-cell">
                        <AssetIcon symbol={market.symbol} />
                        <div>
                          <strong>{market.symbol}</strong>
                          <span className={`side-label ${isLong ? 'pos' : 'neg'}`}>
                            {isLong ? 'Long' : 'Short'} {leverage.toFixed(1)}×
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="num mono">${formatUsd(p.sizeUsd)}</td>
                    <td className="num mono">${formatUsd(p.collateral)}</td>
                    <td className="num mono">
                      ${formatUsd(p.entryPrice, dp)}
                      <span className="sub">${formatUsd(price, dp)}</span>
                    </td>
                    <td className={`num mono ${v.liquidatable ? 'neg' : 'warn'}`}>
                      {v.liquidatable ? 'At risk' : `$${formatUsd(v.liquidationPrice, dp)}`}
                    </td>
                    <td className="num mono">
                      <span className="pos">{tp ? `$${formatUsd(tp.data.triggerPrice, dp)}` : '—'}</span>
                      <span className="sub neg">{sl ? `$${formatUsd(sl.data.triggerPrice, dp)}` : '—'}</span>
                    </td>
                    <td className={`num mono ${net >= 0n ? 'pos' : 'neg'}`}>
                      {signedUsd(net)}
                      <span className="sub">{p.collateral ? `${roi >= 0 ? '+' : '−'}${Math.abs(roi).toFixed(2)}%` : ''}</span>
                    </td>
                    <td className="num">
                      <div className="row-actions">
                        <button
                          className="btn btn-secondary btn-small"
                          onClick={() =>
                            setSharing({ symbol: market.symbol, side: p.side, leverage, pnl: net, roi, entryPrice: p.entryPrice, price, closed: false })
                          }
                        >
                          Share
                        </button>
                        <button className="btn btn-secondary btn-small" disabled={isRunning} onClick={() => setEditing(position)}>
                          Edit
                        </button>
                        <button className="btn btn-secondary btn-small" disabled={isRunning} onClick={() => setClosing(position)}>
                          Close
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
  } else if (tab === 'orders') {
    body = <OrdersTable state={state} orders={orders} positions={positions} />;
  } else {
    body = <HistoryTable state={state} history={history} loading={historyLoading} onShare={setSharing} />;
  }

  return (
    <section className="card positions-card">
      <div className="card-head">
        <div className="segmented" role="tablist" aria-label="Portfolio">
          {tabs.map(([key, label, count]) => (
            <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
              {label} {count != null && <span className="count">{count}</span>}
            </button>
          ))}
        </div>
        {tab === 'positions' && rows.length > 0 && (
          <span className="faint">
            Unrealized PnL <span className={totalNet >= 0n ? 'pos' : 'neg'}>{signedUsd(totalNet)}</span>
          </span>
        )}
      </div>

      {body}
      {tab === 'positions' && <p className="fine left">PnL is shown net of the closing fee, accrued borrow fees and funding.</p>}

      {editingPosition && (
        <EditPosition
          state={state}
          position={editingPosition}
          orders={orders}
          now={now}
          usdcBalance={usdcBalance}
          onClose={() => setEditing(null)}
        />
      )}
      {sharing && <PnlCardModal data={sharing} onClose={() => setSharing(null)} />}

      {closingRow && (
        <Modal title="Close position" onClose={() => setClosing(null)}>
          {(() => {
            const { position, market, price, v } = closingRow;
            const isLong = position.data.side === Side.Long;
            const dp = priceDecimals(price);
            const priceLimit = isLong
              ? (price * (BPS - CLOSE_SLIPPAGE_BPS)) / BPS
              : (price * (BPS + CLOSE_SLIPPAGE_BPS)) / BPS;
            const payout = v.equity > 0n ? v.equity : 0n;
            const attached = orders.filter((o) => isAttached(o, position)).length;
            return (
              <>
                <div className="review-hero">
                  <span className={`badge ${isLong ? 'long' : 'short'}`}>{isLong ? 'Long' : 'Short'}</span>
                  <span className="review-size mono">${formatUsd(payout)}</span>
                  <span className="faint">Estimated USDC you receive</span>
                </div>
                <dl className="kv">
                  <div><dt>Market</dt><dd>{market.symbol}</dd></div>
                  <div><dt>Size</dt><dd className="mono">${formatUsd(position.data.sizeUsd)}</dd></div>
                  <div><dt>Mark price</dt><dd className="mono">${formatUsd(price, dp)}</dd></div>
                  <div><dt>Price limit (1%)</dt><dd className="mono">${formatUsd(priceLimit, dp)}</dd></div>
                  <div><dt>Price PnL</dt><dd className={`mono ${v.pnl >= 0n ? 'pos' : 'neg'}`}>{signedUsd(v.pnl)}</dd></div>
                  <div><dt>Close fee</dt><dd className="mono">−${formatUsd(v.closeFee)}</dd></div>
                  <div><dt>Borrow &amp; funding</dt><dd className="mono">{signedUsd(-v.accruedFees)}</dd></div>
                </dl>
                {attached > 0 && (
                  <p className="fine">Your {attached === 1 ? 'take-profit / stop-loss order' : `${attached} take-profit / stop-loss orders`} on this position will be cancelled too.</p>
                )}
                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={() => setClosing(null)}>Cancel</button>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setClosing(null);
                      run(`Close ${market.symbol} ${isLong ? 'long' : 'short'}`, (owner) =>
                        closePositionIxs({ state, owner, position, priceLimit, orders }),
                      );
                    }}
                  >
                    Close position
                  </button>
                </div>
              </>
            );
          })()}
        </Modal>
      )}
    </section>
  );
}

function OrdersTable({ state, orders, positions }: { state: PerpsState; orders: OrderInfo[]; positions: PositionInfo[] }) {
  const { run, isRunning } = useTx();
  if (orders.length === 0) {
    return (
      <div className="empty">
        <strong>No open orders</strong>
        <span className="faint">Limit orders, take-profits and stop-losses you place will appear here.</span>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Market</th>
            <th>Type</th>
            <th className="num">Trigger</th>
            <th className="num">Mark</th>
            <th className="num">Size</th>
            <th className="num">Collateral</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const o = order.data;
            const market = state.markets.find((m) => m.address === o.market);
            if (!market) return null;
            const isLong = o.side === Side.Long;
            const dp = priceDecimals(market.data.price);
            const orphaned =
              !opensPosition(o.kind) && !positions.some((p) => p.market.address === o.market && p.data.side === o.side);
            return (
              <tr key={order.address}>
                <td>
                  <div className="market-cell">
                    <AssetIcon symbol={market.symbol} />
                    <div>
                      <strong>{market.symbol}</strong>
                      <span className={`side-label ${isLong ? 'pos' : 'neg'}`}>{isLong ? 'Long' : 'Short'}</span>
                    </div>
                  </div>
                </td>
                <td>
                  {orderKindLabel(o.kind)}
                  {orphaned && <span className="sub warn">Position closed</span>}
                </td>
                <td className="num mono">
                  {o.triggerAbove ? '≥' : '≤'} ${formatUsd(o.triggerPrice, dp)}
                </td>
                <td className="num mono">${formatUsd(market.data.price, dp)}</td>
                <td className="num mono">{o.sizeUsd === 0n ? 'Entire' : `$${formatUsd(o.sizeUsd)}`}</td>
                <td className="num mono">{o.collateral > 0n ? `$${formatUsd(o.collateral)}` : '—'}</td>
                <td className="num">
                  <button
                    className="btn btn-secondary btn-small"
                    disabled={isRunning}
                    onClick={() =>
                      run(`Cancel ${orderKindLabel(o.kind).toLowerCase()} ${market.symbol}`, async (owner) => [
                        await cancelOrderIx(state, owner, order),
                      ])
                    }
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTable({
  state,
  history,
  loading,
  onShare,
}: {
  state: PerpsState;
  history: HistoryItem[];
  loading: boolean;
  onShare: (data: PnlCardData) => void;
}) {
  const rows = history.filter((h) => h.event.type !== 'order-executed');
  if (rows.length === 0) {
    return (
      <div className="empty">
        {loading ? <span className="spinner" aria-hidden /> : <strong>No trades yet</strong>}
        <span className="faint">{loading ? 'Loading your recent activity…' : 'Your opens, closes and orders will appear here.'}</span>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Market</th>
            <th>Action</th>
            <th className="num">Price</th>
            <th className="num">Size</th>
            <th className="num">PnL</th>
            <th><span className="sr-only">Links</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item, i) => (
            <HistoryRow key={`${item.signature}-${i}`} state={state} item={item} onShare={onShare} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryRow({ state, item, onShare }: { state: PerpsState; item: HistoryItem; onShare: (data: PnlCardData) => void }) {
  const e = item.event;
  const market = 'market' in e ? state.markets.find((m) => m.address === e.market) : undefined;
  const side = 'side' in e ? e.side : undefined;
  const sideText = side === undefined ? '' : side === Side.Long ? 'Long' : 'Short';
  const dp = 'price' in e ? priceDecimals(e.price) : 2;
  const time = item.time
    ? new Date(item.time * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

  let action = '';
  let pnl: bigint | null = null;
  let share: PnlCardData | null = null;
  switch (e.type) {
    case 'increase':
      action = e.size === 0n ? 'Add collateral' : `Open ${sideText.toLowerCase()}`;
      break;
    case 'decrease':
      action = e.size === 0n ? 'Remove collateral' : `Close part of ${sideText.toLowerCase()}`;
      if (e.size > 0n) pnl = e.pnl - e.fee;
      break;
    case 'close': {
      action = `Close ${sideText.toLowerCase()}`;
      if (e.collateral != null) {
        pnl = e.payout - e.collateral;
        const entry = e.size > 0n && market ? entryFromClose(e.side, e.size, e.pnl, e.price) : 0n;
        if (market && e.collateral > 0n) {
          share = {
            symbol: market.symbol,
            side: e.side,
            leverage: Number(e.size) / Number(e.collateral),
            pnl,
            roi: (Number(pnl) / Number(e.collateral)) * 100,
            entryPrice: entry,
            price: e.price,
            closed: true,
          };
        }
      } else {
        pnl = e.pnl;
      }
      break;
    }
    case 'liquidated':
      action = `Liquidated ${sideText.toLowerCase()}`;
      break;
    case 'order-placed':
      action = `Place ${orderKindLabel(e.kind).toLowerCase()}`;
      break;
    case 'order-cancelled':
      action = 'Cancel order';
      break;
  }

  return (
    <tr>
      <td className="faint">{time}</td>
      <td>
        {market ? (
          <div className="market-cell">
            <AssetIcon symbol={market.symbol} />
            <strong>{market.symbol}</strong>
          </div>
        ) : (
          '—'
        )}
      </td>
      <td className={e.type === 'liquidated' ? 'neg' : side === Side.Long ? 'pos' : side === Side.Short ? 'neg' : ''}>{action}</td>
      <td className="num mono">{'price' in e ? `$${formatUsd(e.price, dp)}` : '—'}</td>
      <td className="num mono">{'size' in e && e.size > 0n ? `$${formatUsd(e.size)}` : '—'}</td>
      <td className={`num mono ${pnl == null ? '' : pnl >= 0n ? 'pos' : 'neg'}`}>{pnl == null ? '—' : signedUsd(pnl)}</td>
      <td className="num">
        <div className="row-actions">
          {share && (
            <button className="btn btn-secondary btn-small" onClick={() => onShare(share!)}>
              Share
            </button>
          )}
          <a className="link" href={explorerTxUrl(item.signature)} target="_blank" rel="noreferrer" aria-label="View transaction">
            ↗
          </a>
        </div>
      </td>
    </tr>
  );
}

/** Recover the entry price from a close event: pnl = ±(size · exit / entry − size). */
function entryFromClose(side: Side, size: bigint, pnl: bigint, exit: bigint): bigint {
  const value = side === Side.Long ? size + pnl : size - pnl;
  return value > 0n ? (size * exit) / value : 0n;
}
