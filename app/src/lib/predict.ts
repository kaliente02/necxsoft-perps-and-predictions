// Prediction-market helpers shared by the web app and the node scripts.
// Mirrors the AMM math in PredictionMarket (programs/my_defi_dapp/src/state.rs).
import {
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
} from '@solana/kit';
import {
  Outcome,
  PREDICTION_MARKET_DISCRIMINATOR,
  PREDICTION_POSITION_DISCRIMINATOR,
  getBuySharesInstruction,
  getCreatePredictionInstruction,
  getPredictionMarketDecoder,
  getPredictionPositionDecoder,
  getRedeemSharesInstruction,
  getResolvePredictionInstruction,
  getResolvePriceMarketInstruction,
  getSellSharesInstruction,
  getWithdrawPredictionLiquidityInstruction,
  type PredictionMarket,
  type PredictionPosition,
} from '../generated';
import { BPS, PROGRAM_ADDRESS, type PerpsState, USD, ata, createAtaIx } from './perps';

export { Outcome };
export type { PredictionMarket, PredictionPosition };

const DEFAULT_ADDRESS = '11111111111111111111111111111111' as Address;
const enc = new TextEncoder();
const addressEncoder = getAddressEncoder();

export type PredictionInfo = {
  address: Address;
  data: PredictionMarket;
  /** Perps market symbol for price markets, null for custom questions. */
  symbol: string | null;
};

export type PredictionPositionInfo = { address: Address; data: PredictionPosition };

export function isPriceMarket(m: PredictionMarket): boolean {
  return m.oracleMarket !== DEFAULT_ADDRESS;
}

export async function predictionPda(id: bigint): Promise<Address> {
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, id, true);
  const [pda] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [enc.encode('prediction'), idBytes] });
  return pda;
}

export async function predictionVaultPda(market: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [enc.encode('prediction_vault'), addressEncoder.encode(market)],
  });
  return pda;
}

export async function predictionPositionPda(market: Address, owner: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [enc.encode('prediction_position'), addressEncoder.encode(market), addressEncoder.encode(owner)],
  });
  return pda;
}

function discriminatorFilter(discriminator: Uint8Array | ArrayLike<number>) {
  return {
    memcmp: {
      offset: 0n,
      bytes: getBase58Decoder().decode(Uint8Array.from(discriminator)) as Base58EncodedBytes,
      encoding: 'base58' as const,
    },
  };
}

/** Every prediction market, open ones first (soonest close), then resolved ones (newest first). */
export async function loadPredictions(rpc: Rpc<SolanaRpcApi>, state: PerpsState | null): Promise<PredictionInfo[]> {
  const accounts = await rpc
    .getProgramAccounts(PROGRAM_ADDRESS, { encoding: 'base64', filters: [discriminatorFilter(PREDICTION_MARKET_DISCRIMINATOR)] })
    .send();
  const decoder = getPredictionMarketDecoder();
  return accounts
    .map(({ pubkey, account }) => {
      const data = decoder.decode(getBase64Encoder().encode(account.data[0]));
      const symbol = isPriceMarket(data) ? (state?.markets.find((m) => m.address === data.oracleMarket)?.symbol ?? null) : null;
      return { address: pubkey, data, symbol };
    })
    .sort((a, b) =>
      a.data.resolved !== b.data.resolved
        ? Number(a.data.resolved) - Number(b.data.resolved)
        : a.data.resolved
          ? Number(b.data.resolvedAt - a.data.resolvedAt)
          : Number(a.data.closeTime - b.data.closeTime),
    );
}

export async function loadPredictionPositions(rpc: Rpc<SolanaRpcApi>, owner: Address): Promise<PredictionPositionInfo[]> {
  const accounts = await rpc
    .getProgramAccounts(PROGRAM_ADDRESS, {
      encoding: 'base64',
      filters: [
        discriminatorFilter(PREDICTION_POSITION_DISCRIMINATOR),
        { memcmp: { offset: 8n, bytes: owner as unknown as Base58EncodedBytes, encoding: 'base58' as const } },
      ],
    })
    .send();
  const decoder = getPredictionPositionDecoder();
  return accounts.map(({ pubkey, account }) => ({ address: pubkey, data: decoder.decode(getBase64Encoder().encode(account.data[0])) }));
}

// ---------- AMM math (bigint, 6-decimal USDC and shares) ----------

/** YES probability in basis points. */
export function yesPriceBps(m: Pick<PredictionMarket, 'yesReserve' | 'noReserve'>): bigint {
  const total = m.yesReserve + m.noReserve;
  return total > 0n ? (m.noReserve * BPS) / total : 5_000n;
}

/** Price of one share of `outcome`, in basis points of $1. */
export function outcomePriceBps(m: PredictionMarket, outcome: Outcome): bigint {
  const yes = yesPriceBps(m);
  return outcome === Outcome.Yes ? yes : BPS - yes;
}

function reserves(m: PredictionMarket, outcome: Outcome): [bigint, bigint] {
  return outcome === Outcome.Yes ? [m.yesReserve, m.noReserve] : [m.noReserve, m.yesReserve];
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) / 2n;
    if (y >= x) return x;
    x = y;
  }
}

function withReserves(m: PredictionMarket, outcome: Outcome, mine: bigint, other: bigint): PredictionMarket {
  return outcome === Outcome.Yes ? { ...m, yesReserve: mine, noReserve: other } : { ...m, noReserve: mine, yesReserve: other };
}

export type Quote = {
  /** Shares bought or sold. */
  shares: bigint;
  /** USDC paid (buy) or received (sell), fees included. */
  amount: bigint;
  fee: bigint;
  /** Average fill price in basis points of $1. */
  avgPriceBps: bigint;
  /** YES probability after the trade. */
  yesAfterBps: bigint;
};

export function quoteBuy(m: PredictionMarket, outcome: Outcome, amount: bigint): Quote | null {
  if (amount <= 0n) return null;
  const fee = (amount * BigInt(m.feeBps)) / BPS;
  const net = amount - fee;
  const [mine, other] = reserves(m, outcome);
  const k = mine * other;
  const otherAfter = other + net;
  const mineAfter = (k + otherAfter - 1n) / otherAfter;
  const shares = mine + net - mineAfter;
  if (shares <= 0n) return null;
  return {
    shares,
    amount,
    fee,
    avgPriceBps: (amount * BPS) / shares,
    yesAfterBps: yesPriceBps(withReserves(m, outcome, mineAfter, otherAfter)),
  };
}

export function quoteSell(m: PredictionMarket, outcome: Outcome, shares: bigint): Quote | null {
  if (shares <= 0n) return null;
  const [mine, other] = reserves(m, outcome);
  const b = mine + shares + other;
  const disc = b * b - 4n * shares * other;
  let x = (b - isqrt(disc)) / 2n;
  if (x > other - 1n) x = other - 1n;
  const k = mine * other;
  while (x > 0n && (mine + shares - x) * (other - x) < k) x -= 1n;
  const fee = (x * BigInt(m.feeBps)) / BPS;
  const amount = x - fee;
  if (amount <= 0n) return null;
  return {
    shares,
    amount,
    fee,
    avgPriceBps: (amount * BPS) / shares,
    yesAfterBps: yesPriceBps(withReserves(m, outcome, mine + shares - x, other - x)),
  };
}

/** USDC a position redeems for after resolution. */
export function payoutOf(m: PredictionMarket, p: PredictionPosition): bigint {
  if (m.outcome === Outcome.Yes) return p.yesShares;
  if (m.outcome === Outcome.No) return p.noShares;
  return (p.yesShares + p.noShares) / 2n;
}

/** Mark-to-market value of a position at current AMM prices (or its payout once resolved). */
export function positionValue(m: PredictionMarket, p: PredictionPosition): bigint {
  if (m.resolved) return payoutOf(m, p);
  const yes = yesPriceBps(m);
  return (p.yesShares * yes + p.noShares * (BPS - yes)) / BPS;
}

export function formatCents(bps: bigint): string {
  const cents = Number(bps) / 100;
  return `${cents < 10 ? cents.toFixed(1) : cents.toFixed(0)}¢`;
}

export function formatPercent(bps: bigint): string {
  return `${(Number(bps) / 100).toFixed(Number(bps) < 100 || Number(bps) > 9_900 ? 1 : 0)}%`;
}

export function outcomeLabel(o: Outcome): string {
  return o === Outcome.Yes ? 'Yes' : o === Outcome.No ? 'No' : 'Invalid';
}

// ---------- instruction builders ----------

export async function buySharesIxs(args: {
  state: PerpsState;
  owner: TransactionSigner;
  market: Address;
  outcome: Outcome;
  amount: bigint;
  minShares: bigint;
}): Promise<Instruction[]> {
  const { state, owner, market } = args;
  return [
    await createAtaIx(owner, owner.address, state.exchange.collateralMint),
    getBuySharesInstruction({
      trader: owner,
      exchange: state.exchangeAddress,
      prediction: market,
      vault: await predictionVaultPda(market),
      position: await predictionPositionPda(market, owner.address),
      userCollateral: await ata(owner.address, state.exchange.collateralMint),
      outcome: args.outcome,
      amount: args.amount,
      minSharesOut: args.minShares,
    }),
  ];
}

export async function sellSharesIxs(args: {
  state: PerpsState;
  owner: TransactionSigner;
  market: Address;
  outcome: Outcome;
  shares: bigint;
  minOut: bigint;
}): Promise<Instruction[]> {
  const { state, owner, market } = args;
  return [
    await createAtaIx(owner, owner.address, state.exchange.collateralMint),
    getSellSharesInstruction({
      trader: owner,
      exchange: state.exchangeAddress,
      prediction: market,
      vault: await predictionVaultPda(market),
      position: await predictionPositionPda(market, owner.address),
      userCollateral: await ata(owner.address, state.exchange.collateralMint),
      outcome: args.outcome,
      shares: args.shares,
      minAmountOut: args.minOut,
    }),
  ];
}

export async function redeemIxs(state: PerpsState, owner: TransactionSigner, market: Address): Promise<Instruction[]> {
  return [
    await createAtaIx(owner, owner.address, state.exchange.collateralMint),
    getRedeemSharesInstruction({
      owner,
      exchange: state.exchangeAddress,
      prediction: market,
      vault: await predictionVaultPda(market),
      position: await predictionPositionPda(market, owner.address),
      userCollateral: await ata(owner.address, state.exchange.collateralMint),
    }),
  ];
}

export async function createPredictionIx(args: {
  state: PerpsState;
  admin: TransactionSigner;
  id: bigint;
  question: string;
  /** Perps market for a price market; omit for a custom question. */
  oracleMarket?: Address;
  strike: bigint;
  closeTime: bigint;
  liquidity: bigint;
  initialYesBps: number;
  feeBps: number;
}): Promise<Instruction> {
  const { state, admin } = args;
  const prediction = await predictionPda(args.id);
  return getCreatePredictionInstruction({
    admin,
    exchange: state.exchangeAddress,
    oracleMarket: args.oracleMarket,
    prediction,
    collateralMint: state.exchange.collateralMint,
    vault: await predictionVaultPda(prediction),
    adminCollateral: await ata(admin.address, state.exchange.collateralMint),
    id: args.id,
    question: args.question,
    strike: args.strike,
    closeTime: args.closeTime,
    liquidity: args.liquidity,
    initialYesBps: args.initialYesBps,
    feeBps: args.feeBps,
  });
}

export function resolvePriceMarketIx(state: PerpsState, m: PredictionInfo): Instruction {
  return getResolvePriceMarketInstruction({
    exchange: state.exchangeAddress,
    prediction: m.address,
    oracleMarket: m.data.oracleMarket,
  });
}

export function resolvePredictionIx(state: PerpsState, admin: TransactionSigner, market: Address, outcome: Outcome): Instruction {
  return getResolvePredictionInstruction({ admin, exchange: state.exchangeAddress, prediction: market, outcome });
}

export async function withdrawPredictionLiquidityIx(state: PerpsState, creator: TransactionSigner, market: Address): Promise<Instruction> {
  return getWithdrawPredictionLiquidityInstruction({
    creator,
    exchange: state.exchangeAddress,
    prediction: market,
    vault: await predictionVaultPda(market),
    creatorCollateral: await ata(creator.address, state.exchange.collateralMint),
  });
}

// ---------- probability history from SharesTraded events ----------

export type ProbabilityPoint = { t: number; yesBps: number };

const SHARES_TRADED = '222,217,188,250,98,184,148,163';
const tradeCache = new Map<string, ProbabilityPoint[]>();

/** YES probability after each trade on `market`, oldest first. */
export async function loadProbabilityHistory(rpc: Rpc<SolanaRpcApi>, market: Address, limit = 60): Promise<ProbabilityPoint[]> {
  const signatures = await rpc.getSignaturesForAddress(market, { limit, commitment: 'confirmed' }).send();
  const ok = signatures.filter((s) => s.err === null);
  const missing = ok.filter((s) => !tradeCache.has(s.signature));
  const addressDecoder = getAddressDecoder();
  for (let i = 0; i < missing.length; i += 5) {
    await Promise.all(
      missing.slice(i, i + 5).map(async (s) => {
        const tx = await rpc
          .getTransaction(s.signature, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'confirmed' })
          .send();
        const points: ProbabilityPoint[] = [];
        for (const line of tx?.meta?.logMessages ?? []) {
          if (!line.startsWith('Program data: ')) continue;
          const bytes = getBase64Encoder().encode(line.slice(14)) as Uint8Array;
          if (Array.from(bytes.subarray(0, 8)).join(',') !== SHARES_TRADED) continue;
          if (addressDecoder.decode(bytes.subarray(8, 40)) !== market) continue;
          // market, owner, outcome u8, buy bool, shares, amount, fee, yes_price_bps
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const yesBps = Number(view.getBigUint64(8 + 32 + 32 + 2 + 24, true));
          points.push({ t: Number(s.blockTime ?? 0), yesBps });
        }
        if (tx) tradeCache.set(s.signature, points);
      }),
    );
  }
  return ok.flatMap((s) => tradeCache.get(s.signature) ?? []).reverse();
}

/** "SOL above $185.00 on Nov 3, 14:00?" style question for a price market. */
export function priceQuestion(symbol: string, strike: bigint, closeTime: bigint): string {
  const asset = symbol.replace(/-PERP$/, '');
  const when = new Date(Number(closeTime) * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  const strikeText = (Number(strike) / Number(USD)).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `Will ${asset} be at or above $${strikeText} on ${when} UTC?`;
}
