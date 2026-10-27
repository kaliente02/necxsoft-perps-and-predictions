// Shared perps helpers used by the web app and the node scripts.
// Mirrors the on-chain math in programs/my_defi_dapp/src/state.rs.
import {
  AccountRole,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getU8Encoder,
} from '@solana/kit';
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';
import {
  MY_DEFI_DAPP_PROGRAM_ADDRESS,
  ORDER_DISCRIMINATOR,
  OrderKind,
  Side,
  fetchAllMaybePosition,
  fetchAllMarket,
  fetchMaybeExchange,
  findExchangePda,
  getAddLiquidityInstruction,
  getCancelOrderInstruction,
  getClosePositionInstruction,
  getDecreasePositionInstruction,
  getIncreasePositionInstruction,
  getOrderDecoder,
  getPlaceOrderInstruction,
  getRemoveLiquidityInstruction,
  type Exchange,
  type Market,
  type Order,
  type Position,
} from '../generated';

export { OrderKind, Side };
export type { Exchange, Market, Order, Position };

export const PROGRAM_ADDRESS = MY_DEFI_DAPP_PROGRAM_ADDRESS;
export const USD = 1_000_000n;
export const BPS = 10_000n;
export const BASE_SCALE = 1_000_000_000n;
export const BORROW_RATE_SCALE = 1_000_000_000n;

const enc = new TextEncoder();
const addressEncoder = getAddressEncoder();

export async function marketPda(exchange: Address, index: number): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [enc.encode('market'), addressEncoder.encode(exchange), getU8Encoder().encode(index)],
  });
  return pda;
}

export async function positionPda(market: Address, owner: Address, side: Side): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [
      enc.encode('position'),
      addressEncoder.encode(market),
      addressEncoder.encode(owner),
      new Uint8Array([side]),
    ],
  });
  return pda;
}

export type MarketInfo = { address: Address; data: Market; symbol: string };

export type PerpsState = {
  exchangeAddress: Address;
  exchange: Exchange;
  markets: MarketInfo[];
};

export function decodeSymbol(bytes: ArrayLike<number>): string {
  return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0+$/, '');
}

/** Load the exchange and every market. Returns null if the exchange isn't initialized. */
export async function loadPerpsState(rpc: Rpc<SolanaRpcApi>): Promise<PerpsState | null> {
  const [exchangeAddress] = await findExchangePda();
  const exchange = await fetchMaybeExchange(rpc, exchangeAddress);
  if (!exchange.exists) return null;
  const addresses = await Promise.all(
    Array.from({ length: exchange.data.numMarkets }, (_, i) => marketPda(exchangeAddress, i)),
  );
  const markets = addresses.length ? await fetchAllMarket(rpc, addresses) : [];
  return {
    exchangeAddress,
    exchange: exchange.data,
    markets: markets.map((m) => ({ address: m.address, data: m.data, symbol: decodeSymbol(m.data.symbol) })),
  };
}

export type PositionInfo = { address: Address; market: MarketInfo; data: Position };

export async function loadPositions(rpc: Rpc<SolanaRpcApi>, state: PerpsState, owner: Address): Promise<PositionInfo[]> {
  const keys = await Promise.all(
    state.markets.flatMap((market) =>
      [Side.Long, Side.Short].map(async (side) => ({ market, address: await positionPda(market.address, owner, side) })),
    ),
  );
  if (!keys.length) return [];
  const accounts = await fetchAllMaybePosition(rpc, keys.map((k) => k.address));
  return accounts.flatMap((account, i) =>
    account.exists ? [{ address: account.address, market: keys[i].market, data: account.data }] : [],
  );
}

// ---------- math (bigint, 6-decimal USD) ----------

export function currentBorrowIndex(market: Market, nowSecs: bigint): bigint {
  const elapsed = nowSecs - market.lastBorrowUpdate;
  if (elapsed <= 0n) return market.cumulativeBorrowIndex;
  return market.cumulativeBorrowIndex + (market.hourlyBorrowRate * elapsed) / 3600n;
}

export function positionPnl(position: Position, price: bigint): bigint {
  const value = (position.base * price) / BASE_SCALE;
  return position.side === Side.Long ? value - position.sizeUsd : position.sizeUsd - value;
}

export type Valuation = {
  pnl: bigint;
  borrowFee: bigint;
  closeFee: bigint;
  equity: bigint;
  maintenanceMargin: bigint;
  liquidatable: boolean;
  liquidationPrice: bigint;
};

export function valuePosition(
  position: Position,
  market: Market,
  exchange: Exchange,
  price: bigint,
  nowSecs: bigint,
): Valuation {
  const pnl = positionPnl(position, price);
  const borrowFee =
    (position.sizeUsd * (currentBorrowIndex(market, nowSecs) - position.entryBorrowIndex)) / BORROW_RATE_SCALE;
  const closeFee = (position.sizeUsd * BigInt(exchange.params.tradeFeeBps)) / BPS;
  const equity = position.collateral + pnl - borrowFee - closeFee;
  const maintenanceMargin = (position.sizeUsd * BigInt(exchange.params.maintenanceMarginBps)) / BPS;
  return {
    pnl,
    borrowFee,
    closeFee,
    equity,
    maintenanceMargin,
    liquidatable: equity < maintenanceMargin,
    liquidationPrice: liquidationPrice(position.side, position.sizeUsd, position.base, position.collateral - borrowFee - closeFee, maintenanceMargin),
  };
}

/** Price at which equity == maintenance margin. `buffer` = collateral net of fees. */
export function liquidationPrice(side: Side, sizeUsd: bigint, base: bigint, buffer: bigint, maintenanceMargin: bigint): bigint {
  if (base === 0n) return 0n;
  // long:  buffer + base*p/S - size = mm  =>  p = (size + mm - buffer) * S / base
  // short: buffer + size - base*p/S = mm  =>  p = (size + buffer - mm) * S / base
  const numerator =
    side === Side.Long ? sizeUsd + maintenanceMargin - buffer : sizeUsd + buffer - maintenanceMargin;
  return numerator <= 0n ? 0n : (numerator * BASE_SCALE) / base;
}

/** Pool AUM = pool balance - aggregate unrealized trader PnL (same as the program). */
export function poolAum(state: PerpsState): bigint {
  let traderPnl = 0n;
  for (const { data: m } of state.markets) {
    const longValue = (m.longBase * m.price) / BASE_SCALE;
    const shortValue = (m.shortBase * m.price) / BASE_SCALE;
    traderPnl += longValue - m.longOpenInterest + (m.shortOpenInterest - shortValue);
  }
  const aum = state.exchange.poolBalance - traderPnl;
  return aum > 0n ? aum : 0n;
}

// ---------- formatting / parsing ----------

export function formatUsd(value: bigint, decimals = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / USD;
  const frac = (abs % USD).toString().padStart(6, '0').slice(0, decimals);
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${wholeStr}${decimals ? '.' + frac : ''}`;
}

/** "+$12.34" / "−$12.34" */
export function signedUsd(value: bigint): string {
  return `${value >= 0n ? '+' : '−'}$${formatUsd(value < 0n ? -value : value)}`;
}

export function priceDecimals(price: bigint): number {
  return price >= 1000n * USD ? 2 : price >= USD ? 3 : 5;
}

/** Parse a decimal string like "12.5" into 6-decimal base units. */
export function parseUsd(input: string): bigint | null {
  const match = input.trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!match || (match[1] === '' && !match[2])) return null;
  const frac = (match[2] ?? '').slice(0, 6).padEnd(6, '0');
  return BigInt(match[1] || '0') * USD + BigInt(frac);
}

// ---------- instruction builders ----------

export async function ata(owner: Address, mint: Address): Promise<Address> {
  const [address] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return address;
}

export function createAtaIx(payer: TransactionSigner, owner: Address, mint: Address): Promise<Instruction> {
  return getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint });
}

export async function increasePositionIxs(args: {
  state: PerpsState;
  owner: TransactionSigner;
  market: Address;
  side: Side;
  collateral: bigint;
  sizeUsd: bigint;
  priceLimit: bigint;
}): Promise<Instruction[]> {
  const { state, owner, market, side } = args;
  return [
    getIncreasePositionInstruction({
      owner,
      exchange: state.exchangeAddress,
      market,
      position: await positionPda(market, owner.address, side),
      vault: state.exchange.vault,
      userCollateral: await ata(owner.address, state.exchange.collateralMint),
      side,
      collateralAmount: args.collateral,
      sizeDeltaUsd: args.sizeUsd,
      priceLimit: args.priceLimit,
    }),
  ];
}

/** Close a position; any take-profit / stop-loss orders attached to it are cancelled in the same transaction. */
export async function closePositionIxs(args: {
  state: PerpsState;
  owner: TransactionSigner;
  position: PositionInfo;
  priceLimit: bigint;
  orders?: OrderInfo[];
}): Promise<Instruction[]> {
  const { state, owner, position } = args;
  const attached = (args.orders ?? []).filter((o) => isAttached(o, position));
  return [
    await createAtaIx(owner, owner.address, state.exchange.collateralMint),
    getClosePositionInstruction({
      owner,
      exchange: state.exchangeAddress,
      market: position.market.address,
      position: position.address,
      vault: state.exchange.vault,
      userCollateral: await ata(owner.address, state.exchange.collateralMint),
      priceLimit: args.priceLimit,
    }),
    ...(await Promise.all(attached.map((order) => cancelOrderIx(state, owner, order)))),
  ];
}

/** Partially close (`sizeUsd` > 0) and/or withdraw collateral from a position. */
export async function decreasePositionIxs(args: {
  state: PerpsState;
  owner: TransactionSigner;
  position: PositionInfo;
  sizeUsd: bigint;
  collateralOut: bigint;
  priceLimit: bigint;
}): Promise<Instruction[]> {
  const { state, owner, position } = args;
  return [
    await createAtaIx(owner, owner.address, state.exchange.collateralMint),
    getDecreasePositionInstruction({
      owner,
      exchange: state.exchangeAddress,
      market: position.market.address,
      position: position.address,
      vault: state.exchange.vault,
      userCollateral: await ata(owner.address, state.exchange.collateralMint),
      sizeDeltaUsd: args.sizeUsd,
      collateralOut: args.collateralOut,
      priceLimit: args.priceLimit,
    }),
  ];
}

// ---------- orders (limit, take-profit, stop-loss) ----------

export type OrderInfo = { address: Address; data: Order };

export async function orderPda(owner: Address, id: bigint): Promise<Address> {
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, id, true);
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [enc.encode('order'), addressEncoder.encode(owner), idBytes],
  });
  return pda;
}

/** A fresh order id; part of the order PDA seeds. */
export function newOrderId(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}

const ORDER_OWNER_OFFSET = 8n;

/** All open orders, or only `owner`'s when given. */
export async function loadOrders(rpc: Rpc<SolanaRpcApi>, owner?: Address): Promise<OrderInfo[]> {
  const filters = [
    { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(ORDER_DISCRIMINATOR) as Base58EncodedBytes, encoding: 'base58' as const } },
    ...(owner ? [{ memcmp: { offset: ORDER_OWNER_OFFSET, bytes: owner as unknown as Base58EncodedBytes, encoding: 'base58' as const } }] : []),
  ];
  const accounts = await rpc.getProgramAccounts(PROGRAM_ADDRESS, { encoding: 'base64', filters }).send();
  const decoder = getOrderDecoder();
  return accounts
    .map(({ pubkey, account }) => ({ address: pubkey, data: decoder.decode(getBase64Encoder().encode(account.data[0])) }))
    .sort((a, b) => Number(b.data.createdAt - a.data.createdAt));
}

/** Whether a take-profit / stop-loss order belongs to this position. */
export function isAttached(order: OrderInfo, position: PositionInfo): boolean {
  return (
    order.data.kind !== OrderKind.Limit &&
    order.data.market === position.market.address &&
    order.data.side === position.data.side
  );
}

export async function placeOrderIx(args: {
  state: PerpsState;
  owner: TransactionSigner;
  market: Address;
  side: Side;
  kind: OrderKind;
  triggerPrice: bigint;
  sizeUsd: bigint;
  collateral: bigint;
}): Promise<Instruction> {
  const { state, owner } = args;
  const id = newOrderId();
  return getPlaceOrderInstruction({
    owner,
    exchange: state.exchangeAddress,
    market: args.market,
    order: await orderPda(owner.address, id),
    vault: state.exchange.vault,
    userCollateral: await ata(owner.address, state.exchange.collateralMint),
    id,
    side: args.side,
    kind: args.kind,
    triggerPrice: args.triggerPrice,
    sizeUsd: args.sizeUsd,
    collateral: args.collateral,
  });
}

export async function cancelOrderIx(state: PerpsState, owner: TransactionSigner, order: OrderInfo): Promise<Instruction> {
  return getCancelOrderInstruction({
    owner,
    exchange: state.exchangeAddress,
    order: order.address,
    vault: state.exchange.vault,
    userCollateral: await ata(owner.address, state.exchange.collateralMint),
  });
}

/** Whether `triggerPrice` is on the correct side of the mark for this kind of order to rest. */
export function triggerProblem(kind: OrderKind, side: Side, triggerPrice: bigint, mark: bigint): string | null {
  if (triggerPrice <= 0n) return 'Enter a trigger price';
  const isLong = side === Side.Long;
  // Limit buys below / sells above the mark; TP is in the position's favour; SL against it.
  const mustBeBelow =
    kind === OrderKind.Limit ? isLong : kind === OrderKind.TakeProfit ? !isLong : isLong;
  if (mustBeBelow && triggerPrice >= mark) return `${orderKindLabel(kind)} price must be below the mark price`;
  if (!mustBeBelow && triggerPrice <= mark) return `${orderKindLabel(kind)} price must be above the mark price`;
  return null;
}

export function orderKindLabel(kind: OrderKind): string {
  return kind === OrderKind.Limit ? 'Limit' : kind === OrderKind.TakeProfit ? 'Take profit' : 'Stop loss';
}

/** Estimated PnL (before fees) of closing `sizeUsd` of a position at `price`. */
export function pnlAt(position: Position, sizeUsd: bigint, price: bigint): bigint {
  if (position.sizeUsd === 0n) return 0n;
  const base = (position.base * sizeUsd) / position.sizeUsd;
  const value = (base * price) / BASE_SCALE;
  return position.side === Side.Long ? value - sizeUsd : sizeUsd - value;
}

// ---------- trade history (decoded from program events in transaction logs) ----------

export type TradeEvent =
  | { type: 'increase'; market: Address; side: Side; price: bigint; size: bigint; collateral: bigint; fee: bigint }
  | { type: 'decrease'; market: Address; side: Side; price: bigint; size: bigint; pnl: bigint; fee: bigint; payout: bigint }
  | { type: 'close'; market: Address; side: Side; price: bigint; size: bigint; pnl: bigint; payout: bigint; collateral: bigint | null }
  | { type: 'liquidated'; market: Address; side: Side; price: bigint; size: bigint }
  | { type: 'order-placed'; market: Address; side: Side; kind: OrderKind; price: bigint; size: bigint; collateral: bigint }
  | { type: 'order-cancelled' }
  | { type: 'order-executed'; kind: OrderKind; price: bigint };

export type HistoryItem = { signature: string; time: number | null; event: TradeEvent };

// Anchor event discriminators, from target/idl/my_defi_dapp.json.
const EVENTS: Record<string, string> = {
  '73,58,247,181,100,237,249,81': 'PositionIncreased',
  '251,151,37,204,127,87,115,232': 'PositionDecreased',
  '157,163,227,228,13,97,138,121': 'PositionClosed',
  '40,107,90,214,96,30,61,128': 'PositionLiquidated',
  '96,130,204,234,169,219,216,227': 'OrderPlaced',
  '108,56,128,68,168,113,168,239': 'OrderCancelled',
  '74,135,231,5,168,106,194,117': 'OrderExecuted',
};

class Reader {
  private offset = 8;
  private view: DataView;
  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining() { return this.bytes.length - this.offset; }
  address(): Address {
    const a = getAddressDecoder().decode(this.bytes.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return a;
  }
  u8() { return this.view.getUint8(this.offset++); }
  u64() { const v = this.view.getBigUint64(this.offset, true); this.offset += 8; return v; }
  i64() { const v = this.view.getBigInt64(this.offset, true); this.offset += 8; return v; }
}

/** Decode one "Program data:" payload, returning the event if it concerns `owner` (any owner when null). */
export function decodeEvent(bytes: Uint8Array, owner: Address | null): TradeEvent | null {
  const name = EVENTS[Array.from(bytes.subarray(0, 8)).join(',')];
  if (!name) return null;
  const r = new Reader(bytes);
  const eventOwner = r.address();
  if (owner && eventOwner !== owner) return null;
  switch (name) {
    case 'PositionIncreased': {
      const market = r.address(), side = r.u8() as Side, price = r.u64(), size = r.u64(), collateral = r.u64(), fee = r.u64();
      return { type: 'increase', market, side, price, size, collateral, fee };
    }
    case 'PositionDecreased': {
      const market = r.address(), side = r.u8() as Side, price = r.u64(), size = r.u64(), pnl = r.i64(), fee = r.u64(), payout = r.u64();
      return { type: 'decrease', market, side, price, size, pnl, fee, payout };
    }
    case 'PositionClosed': {
      const market = r.address(), side = r.u8() as Side, price = r.u64(), size = r.u64(), pnl = r.i64(), payout = r.u64();
      // Events emitted before the collateral field existed end here.
      const collateral = r.remaining >= 8 ? r.u64() : null;
      return { type: 'close', market, side, price, size, pnl, payout, collateral };
    }
    case 'PositionLiquidated': {
      const market = r.address();
      r.address(); // liquidator
      const side = r.u8() as Side, price = r.u64(), size = r.u64();
      return { type: 'liquidated', market, side, price, size };
    }
    case 'OrderPlaced': {
      r.address(); // order
      const market = r.address(), side = r.u8() as Side, kind = r.u8() as OrderKind, price = r.u64(), size = r.u64(), collateral = r.u64();
      return { type: 'order-placed', market, side, kind, price, size, collateral };
    }
    case 'OrderCancelled':
      return { type: 'order-cancelled' };
    case 'OrderExecuted': {
      r.address(); // order
      r.address(); // executor
      const kind = r.u8() as OrderKind, price = r.u64();
      return { type: 'order-executed', kind, price };
    }
  }
  return null;
}

const txCache = new Map<string, HistoryItem[]>();

/** The owner's recent exchange activity, newest first. Transactions are cached, so polling only fetches new ones. */
export async function loadHistory(rpc: Rpc<SolanaRpcApi>, owner: Address, limit = 30): Promise<HistoryItem[]> {
  const signatures = await rpc.getSignaturesForAddress(owner, { limit, commitment: 'confirmed' }).send();
  const ok = signatures.filter((s) => s.err === null);
  const missing = ok.filter((s) => !txCache.has(s.signature));
  // Small batches keep public RPC endpoints from rate-limiting us.
  for (let i = 0; i < missing.length; i += 5) {
    await Promise.all(
      missing.slice(i, i + 5).map(async (s) => {
        const tx = await rpc
          .getTransaction(s.signature, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'confirmed' })
          .send();
        const items: HistoryItem[] = [];
        for (const line of tx?.meta?.logMessages ?? []) {
          if (!line.startsWith('Program data: ')) continue;
          const event = decodeEvent(getBase64Encoder().encode(line.slice(14)) as Uint8Array, owner);
          if (event) items.push({ signature: s.signature, time: s.blockTime == null ? null : Number(s.blockTime), event });
        }
        if (tx) txCache.set(s.signature, items);
      }),
    );
  }
  return ok.flatMap((s) => txCache.get(s.signature) ?? []);
}

export type MarketTrade = {
  signature: string;
  time: number | null;
  /** Buy = opening a long or closing a short; sell = the reverse. */
  buy: boolean;
  label: string;
  price: bigint;
  size: bigint;
};

const marketTxCache = new Map<string, MarketTrade[]>();

/** Recent fills on `market` by every trader, newest first. */
export async function loadMarketTrades(rpc: Rpc<SolanaRpcApi>, market: Address, limit = 25): Promise<MarketTrade[]> {
  const signatures = await rpc.getSignaturesForAddress(market, { limit, commitment: 'confirmed' }).send();
  const ok = signatures.filter((s) => s.err === null);
  const missing = ok.filter((s) => !marketTxCache.has(s.signature));
  for (let i = 0; i < missing.length; i += 5) {
    await Promise.all(
      missing.slice(i, i + 5).map(async (s) => {
        const tx = await rpc
          .getTransaction(s.signature, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'confirmed' })
          .send();
        const trades: MarketTrade[] = [];
        for (const line of tx?.meta?.logMessages ?? []) {
          if (!line.startsWith('Program data: ')) continue;
          const e = decodeEvent(getBase64Encoder().encode(line.slice(14)) as Uint8Array, null);
          if (!e || !('market' in e) || e.market !== market || e.type === 'order-placed') continue;
          const long = e.side === Side.Long;
          const opening = e.type === 'increase';
          const label = e.type === 'liquidated' ? 'Liquidation' : `${opening ? 'Open' : 'Close'} ${long ? 'long' : 'short'}`;
          trades.push({
            signature: s.signature,
            time: s.blockTime == null ? null : Number(s.blockTime),
            buy: opening === long,
            label,
            price: e.price,
            size: e.size,
          });
        }
        if (tx) marketTxCache.set(s.signature, trades);
      }),
    );
  }
  return ok.flatMap((s) => marketTxCache.get(s.signature) ?? []);
}

function withMarkets(ix: Instruction, state: PerpsState): Instruction {
  return {
    ...ix,
    accounts: [
      ...(ix.accounts ?? []),
      ...state.markets.map((m) => ({ address: m.address, role: AccountRole.READONLY })),
    ],
  };
}

export async function liquidityIxs(args: {
  state: PerpsState;
  owner: TransactionSigner;
  deposit: boolean;
  amount: bigint;
  minOut: bigint;
}): Promise<Instruction[]> {
  const { state, owner } = args;
  const accounts = {
    owner,
    exchange: state.exchangeAddress,
    vault: state.exchange.vault,
    lpMint: state.exchange.lpMint,
    userCollateral: await ata(owner.address, state.exchange.collateralMint),
    userLp: await ata(owner.address, state.exchange.lpMint),
  };
  const ix = args.deposit
    ? getAddLiquidityInstruction({ ...accounts, amount: args.amount, minLpOut: args.minOut })
    : getRemoveLiquidityInstruction({ ...accounts, lpAmount: args.amount, minAmountOut: args.minOut });
  return [
    await createAtaIx(owner, owner.address, state.exchange.collateralMint),
    await createAtaIx(owner, owner.address, state.exchange.lpMint),
    withMarkets(ix, state),
  ];
}

export async function tokenBalance(rpc: Rpc<SolanaRpcApi>, owner: Address, mint: Address): Promise<bigint> {
  try {
    const { value } = await rpc.getTokenAccountBalance(await ata(owner, mint), { commitment: 'confirmed' }).send();
    return BigInt(value.amount);
  } catch {
    return 0n; // account does not exist yet
  }
}
