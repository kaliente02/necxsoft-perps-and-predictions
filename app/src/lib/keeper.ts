// Off-chain keeper:
//  1. pushes reference prices (Coinbase spot) on-chain for every market, every INTERVAL_MS
//  2. scans all positions and liquidates any below maintenance margin (earning the liquidation fee)
//  3. fills limit, take-profit and stop-loss orders whose trigger price has been reached
//  4. resolves expired price prediction markets from the oracle, and withdraws the liquidity of
//     resolved markets it created
//  5. keeps one rolling "above the strike?" price market open per perps market, each running
//     ROLL_HOURS (default 4; ROLL_HOURS=0 disables), seeded with ROLL_LIQUIDITY USDC (default 2,000).
//     The admin or a market's oracle authority may open them, so the hosted keeper does this too.
//
//   npm run keeper            (scripts/keeper.ts, locally)
//   worker/index.ts           (Cloudflare cron, hosted)
import {
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type InstructionPlan,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  getBase58Decoder,
  getBase64Encoder,
} from '@solana/kit';
import {
  POSITION_DISCRIMINATOR,
  fetchMaybePosition,
  findHistoryPda,
  findLiquidationFeedPda,
  getExecuteLimitOrderInstruction,
  getExecuteTriggerOrderInstruction,
  getLiquidateInstruction,
  getPositionDecoder,
  getUpdatePriceInstruction,
} from '../generated';
import {
  type OrderInfo,
  type PerpsState,
  PROGRAM_ADDRESS,
  ata,
  createAtaIx,
  formatUsd,
  loadOrders,
  loadPerpsState,
  opensPosition,
  orderKindLabel,
  positionPda,
  tokenBalance,
  valuePosition,
} from './perps';
import {
  createPredictionIx,
  isPriceMarket,
  loadPredictions,
  priceQuestion,
  resolvePriceMarketIx,
  withdrawPredictionLiquidityIx,
} from './predict';
import { getMintToATAInstructionPlanAsync } from '@solana-program/token';
import { fetchPrices } from './prices';

export type KeeperClient = {
  rpc: Rpc<SolanaRpcApi>;
  payer: TransactionSigner;
  sendTransaction: (input: Instruction[] | InstructionPlan) => Promise<unknown>;
};

export type KeeperOptions = {
  /**
   * Hours each rolling price market runs; 0 disables them. Opening one needs the admin key or the
   * perps market's oracle authority key.
   */
  rollHours: number;
  /** USDC (6 decimals) that seeds each rolling market. */
  rollLiquidity: bigint;
  /** Mint the seed USDC (needs the mint authority) instead of paying it from the keeper's balance. */
  mintLiquidity: boolean;
  log?: (...args: unknown[]) => void;
};

/** One keeper pass over prices, liquidations, orders and prediction markets. */
export function createKeeper(client: KeeperClient, opts: KeeperOptions) {
  const positionDecoder = getPositionDecoder();
  const ROLL_HOURS = opts.rollHours;
  const ROLL_LIQUIDITY = opts.rollLiquidity;
  const console = { log: opts.log ?? globalThis.console.log, warn: opts.log ?? globalThis.console.warn };

  /** `predictions: false` skips resolving and opening prediction markets, to save RPC requests. */
  async function tick({ predictions: withPredictions = true } = {}) {
    const state = await loadPerpsState(client.rpc);
    if (!state) throw new Error('Exchange not initialized; run `npm run setup -- init` first');

    // 1. Prices
    const prices = await fetchPrices(state.markets.map((m) => m.symbol));
    const updates = await Promise.all(
      state.markets
        .filter((m) => prices[m.symbol] && m.data.oracleAuthority === client.payer.address)
        .map(async (m) =>
          getUpdatePriceInstruction({
            oracleAuthority: client.payer,
            market: m.address,
            history: (await findHistoryPda({ market: m.address }))[0],
            price: prices[m.symbol],
          }),
        ),
    );
    if (updates.length) {
      await client.sendTransaction(updates);
      console.log(
        new Date().toISOString(),
        state.markets.map((m) => `${m.symbol}=${prices[m.symbol] ? formatUsd(prices[m.symbol]) : '?'}`).join(' '),
      );
    }

    // 2. Liquidations
    const fresh = (await loadPerpsState(client.rpc))!;
    const accounts = await client.rpc
      .getProgramAccounts(PROGRAM_ADDRESS, {
        encoding: 'base64',
        filters: [
          { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(POSITION_DISCRIMINATOR) as Base58EncodedBytes, encoding: 'base58' } },
        ],
      })
      .send();
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const { pubkey, account } of accounts) {
      const position = positionDecoder.decode(getBase64Encoder().encode(account.data[0]));
      const market = fresh.markets.find((m) => m.address === position.market);
      if (!market) continue;
      const valuation = valuePosition(position, market.data, fresh.exchange, market.data.price, now);
      if (!valuation.liquidatable) continue;
      console.log(`Liquidating ${pubkey} (${market.symbol}, equity ${formatUsd(valuation.equity)})`);
      try {
        await liquidate(pubkey, position.owner, market.address, fresh);
      } catch (e) {
        console.warn(`  failed: ${(e as Error).message}`);
      }
    }

    // 3. Orders
    for (const order of await loadOrders(client.rpc)) {
      const market = fresh.markets.find((m) => m.address === order.data.market);
      if (!market) continue;
      const price = market.data.price;
      const { triggerAbove, triggerPrice, kind } = order.data;
      if (triggerAbove ? price < triggerPrice : price > triggerPrice) continue;
      console.log(`Filling ${orderKindLabel(kind)} ${order.address} (${market.symbol} at ${formatUsd(price)})`);
      try {
        await executeOrder(order, fresh);
      } catch (e) {
        console.warn(`  failed: ${(e as Error).message}`);
      }
    }

    // 4 + 5. Prediction markets
    if (withPredictions) await predictions(fresh, now);
  }

  async function predictions(state: PerpsState, now: bigint) {
    const markets = await loadPredictions(client.rpc, state);
    for (const m of markets) {
      const { data } = m;
      if (!data.resolved && isPriceMarket(data) && now >= data.closeTime) {
        const oracle = state.markets.find((x) => x.address === data.oracleMarket);
        if (!oracle || oracle.data.priceUpdatedAt < data.closeTime) continue;
        console.log(`Resolving ${m.address}: ${data.question} (${oracle.symbol} ${formatUsd(oracle.data.price)})`);
        try {
          await client.sendTransaction([resolvePriceMarketIx(state, m)]);
        } catch (e) {
          console.warn(`  failed: ${(e as Error).message}`);
        }
      } else if (data.resolved && data.creator === client.payer.address && data.yesReserve + data.noReserve + data.fees > 0n) {
        try {
          await client.sendTransaction([
            await createAtaIx(client.payer, client.payer.address, state.exchange.collateralMint),
            await withdrawPredictionLiquidityIx(state, client.payer, m.address),
          ]);
          console.log(`Withdrew liquidity from resolved ${m.address}`);
        } catch (e) {
          console.warn(`  withdraw failed: ${(e as Error).message}`);
        }
      }
    }

    if (ROLL_HOURS <= 0) return;
    const mint = state.exchange.collateralMint;
    let balance = opts.mintLiquidity ? 0n : await tokenBalance(client.rpc, client.payer.address, mint);
    for (const perp of state.markets) {
      const mayCreate = state.exchange.admin === client.payer.address || perp.data.oracleAuthority === client.payer.address;
      // Any open price market on this perp counts, so a second keeper doesn't open a duplicate.
      const open = markets.some((m) => !m.data.resolved && m.data.oracleMarket === perp.address && m.data.closeTime > now);
      if (!mayCreate || open || now - perp.data.priceUpdatedAt > 60n) continue;
      if (!opts.mintLiquidity && balance < ROLL_LIQUIDITY) {
        console.warn(`  not enough USDC to open a rolling ${perp.symbol} market (${formatUsd(balance)})`);
        continue;
      }
      const price = Number(perp.data.price) / 1e6;
      const step = 10 ** Math.max(0, Math.floor(Math.log10(price)) - 2);
      const strike = BigInt(Math.round(Math.round(price / step) * step * 1e6));
      // Close on a whole hour, at least ROLL_HOURS from now.
      const closeTime = (now / 3600n + BigInt(Math.ceil(ROLL_HOURS))) * 3600n;
      try {
        const id = BigInt(Date.now()) * 1000n + BigInt(perp.data.index);
        if (opts.mintLiquidity) {
          await client.sendTransaction(
            await getMintToATAInstructionPlanAsync({
              payer: client.payer,
              owner: client.payer.address,
              mint,
              mintAuthority: client.payer,
              amount: ROLL_LIQUIDITY,
              decimals: 6,
            }),
          );
        }
        await client.sendTransaction([
          await createPredictionIx({
            state,
            creator: client.payer,
            id,
            question: priceQuestion(perp.symbol, strike, closeTime),
            oracleMarket: perp.address,
            strike,
            closeTime,
            liquidity: ROLL_LIQUIDITY,
            initialYesBps: 5_000,
            feeBps: 100,
          }),
        ]);
        balance -= ROLL_LIQUIDITY;
        console.log(`Opened rolling market: ${priceQuestion(perp.symbol, strike, closeTime)}`);
      } catch (e) {
        console.warn(`  rolling market for ${perp.symbol} failed: ${(e as Error).message}`);
      }
    }
  }

  async function executeOrder(order: OrderInfo, state: PerpsState) {
    const { owner, market, side } = order.data;
    const position = await positionPda(market, owner, side);
    if (opensPosition(order.data.kind)) {
      await client.sendTransaction([
        getExecuteLimitOrderInstruction({
          executor: client.payer,
          exchange: state.exchangeAddress,
          market,
          order: order.address,
          owner,
          position,
        }),
      ]);
      return;
    }
    // A take-profit / stop-loss whose position is gone (closed or liquidated) waits for its owner to cancel it.
    if (!(await fetchMaybePosition(client.rpc, position)).exists) {
      console.log('  position no longer open; skipping');
      return;
    }
    const mint = state.exchange.collateralMint;
    await client.sendTransaction([
      await createAtaIx(client.payer, owner, mint),
      getExecuteTriggerOrderInstruction({
        executor: client.payer,
        exchange: state.exchangeAddress,
        market,
        order: order.address,
        owner,
        position,
        ownerCollateral: await ata(owner, mint),
        vault: state.exchange.vault,
      }),
    ]);
  }

  async function liquidate(
    position: Address,
    owner: Address,
    market: Address,
    state: PerpsState,
  ) {
    const mint = state.exchange.collateralMint;
    await client.sendTransaction([
      await createAtaIx(client.payer, owner, mint),
      await createAtaIx(client.payer, client.payer.address, mint),
      getLiquidateInstruction({
        liquidator: client.payer,
        exchange: state.exchangeAddress,
        market,
        position,
        owner,
        ownerCollateral: await ata(owner, mint),
        liquidatorCollateral: await ata(client.payer.address, mint),
        vault: state.exchange.vault,
        liquidationFeed: (await findLiquidationFeedPda())[0],
      }),
    ]);
  }

  return { tick };
}
