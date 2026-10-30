// Admin setup for a local or devnet deployment.
//
//   npm run setup -- init                 create mock USDC, initialize exchange, add SOL/BTC/ETH markets
//   npm run setup -- faucet <wallet> [n]  mint n (default 10,000) mock USDC to a wallet
//   npm run setup -- seed [n]             mint n (default 100,000) mock USDC to the admin and deposit it as pool liquidity
//   npm run setup -- set-oracle <address> make <address> every market's oracle authority (keeps borrow rate and OI cap)
//   npm run setup -- configure            set every market's funding rate; also migrates markets created before
//                                         funding and creates their hourly history and the liquidation feed
//
// Prediction markets (liquidity in USDC, minted to the admin as needed):
//   npm run setup -- predict-price <SYMBOL> <strike> <hours> [liquidity]
//   npm run setup -- predict-custom "<question>" <hours> [yes%] [liquidity]
//   npm run setup -- predict-demo         one 24h price market per perps market plus sample custom questions
//   npm run setup -- predict-resolve <market> yes|no|invalid
//   npm run setup -- predict-withdraw <market>
//
// Uses KEYPAIR (default ~/.config/solana/id.json) as admin, oracle authority and USDC mint authority.
import { address, generateKeyPairSigner } from '@solana/kit';
import { getCreateMintInstructionPlan, getMintToATAInstructionPlanAsync } from '@solana-program/token';
import {
  findExchangePda,
  findLpMintPda,
  findInitializeVaultPda,
  getAddMarketInstruction,
  getConfigureMarketInstructionAsync,
  getInitializeInstruction,
  getUpdateMarketInstruction,
} from '../src/generated';
import { type PerpsState, USD, formatUsd, liquidityIxs, loadPerpsState, marketPda, newOrderId, poolAum, tokenBalance } from '../src/lib/perps';
import {
  Outcome,
  createPredictionIx,
  loadPredictions,
  predictionPda,
  priceQuestion,
  resolvePredictionIx,
  withdrawPredictionLiquidityIx,
} from '../src/lib/predict';
import { RPC_URL, createScriptClient, fetchPrices } from './common';

const MARKETS = [
  // symbol, fallback price, hourly borrow rate (1e9 = 100%/h; 100_000 = 0.01%/h), per-side OI cap,
  // hourly funding rate when all open interest is on one side (same scale)
  { symbol: 'SOL-PERP', fallbackPrice: 150n * USD, hourlyBorrowRate: 100_000n, maxOpenInterest: 5_000_000n * USD, maxFunding: 200_000n },
  { symbol: 'BTC-PERP', fallbackPrice: 100_000n * USD, hourlyBorrowRate: 80_000n, maxOpenInterest: 5_000_000n * USD, maxFunding: 150_000n },
  { symbol: 'ETH-PERP', fallbackPrice: 3_500n * USD, hourlyBorrowRate: 80_000n, maxOpenInterest: 5_000_000n * USD, maxFunding: 150_000n },
];

const client = await createScriptClient();
const [command, ...args] = process.argv.slice(2);
console.log(`RPC ${RPC_URL}  admin ${client.payer.address}`);

if (command === 'init') {
  await init();
} else if (command === 'faucet') {
  await faucet(args[0], args[1]);
} else if (command === 'seed') {
  await seed(args[0]);
} else if (command === 'set-oracle') {
  await setOracle(args[0]);
} else if (command === 'configure') {
  await configure();
} else if (command === 'predict-price') {
  await predictPrice(args[0], args[1], args[2], args[3]);
} else if (command === 'predict-custom') {
  await predictCustom(args[0], args[1], args[2], args[3]);
} else if (command === 'predict-demo') {
  await predictDemo();
} else if (command === 'predict-resolve') {
  await predictResolve(args[0], args[1]);
} else if (command === 'predict-withdraw') {
  await predictWithdraw(args[0]);
} else {
  console.log(
    'usage: npm run setup -- init | faucet <wallet> [amount] | seed [amount] | set-oracle <address> | predict-price | predict-custom | predict-demo | predict-resolve | predict-withdraw',
  );
  process.exit(1);
}

async function init() {
  let state = await loadPerpsState(client.rpc);
  if (!state) {
    const usdc = await generateKeyPairSigner();
    console.log(`Creating mock USDC mint ${usdc.address}`);
    await client.sendTransaction(
      await getCreateMintInstructionPlan(client, {
        payer: client.payer,
        newMint: usdc,
        decimals: 6,
        mintAuthority: client.payer.address,
      }),
    );

    const [exchange] = await findExchangePda();
    const [vault] = await findInitializeVaultPda({ exchange });
    const [lpMint] = await findLpMintPda({ exchange });
    console.log(`Initializing exchange ${exchange}`);
    await client.sendTransaction([
      getInitializeInstruction({
        admin: client.payer,
        exchange,
        collateralMint: usdc.address,
        vault,
        lpMint,
        params: {
          maxLeverage: 50,
          tradeFeeBps: 6,
          maintenanceMarginBps: 100,
          liquidationFeeBps: 50,
          maxUtilizationBps: 8_000,
          maxPriceAgeSecs: 120,
          minCollateral: 5n * USD,
        },
      }),
    ]);
    state = (await loadPerpsState(client.rpc))!;
  } else {
    console.log(`Exchange already initialized (collateral mint ${state.exchange.collateralMint})`);
  }

  const existing = new Set(state.markets.map((m) => m.symbol));
  const missing = MARKETS.filter((m) => !existing.has(m.symbol));
  const prices = await fetchPrices(missing.map((m) => m.symbol)).catch((e) => {
    console.warn(`Price API unavailable (${e.message}); using fallback prices`);
    return {} as Record<string, bigint>;
  });
  let index = state.exchange.numMarkets;
  for (const m of missing) {
    const market = await marketPda(state.exchangeAddress, index++);
    const price = prices[m.symbol] ?? m.fallbackPrice;
    console.log(`Adding ${m.symbol} at $${Number(price) / 1e6} -> ${market}`);
    await client.sendTransaction([
      getAddMarketInstruction({
        admin: client.payer,
        exchange: state.exchangeAddress,
        market,
        symbol: m.symbol,
        oracleAuthority: client.payer.address,
        initialPrice: price,
        hourlyBorrowRate: m.hourlyBorrowRate,
        maxOpenInterest: m.maxOpenInterest,
      }),
    ]);
  }
  await configure();
  console.log('Done. Run `npm run keeper` to stream prices and liquidate unhealthy positions.');
}

async function configure() {
  // Read raw accounts: markets created before funding don't decode with the current client.
  const [exchange] = await findExchangePda();
  const { value: exchangeAccount } = await client.rpc.getAccountInfo(exchange, { encoding: 'base64' }).send();
  if (!exchangeAccount) throw new Error('Exchange not initialized; run `npm run setup -- init` first');
  // num_markets: after the discriminator, 4 pubkeys and 3 u64s.
  const numMarkets = Buffer.from(exchangeAccount.data[0], 'base64')[8 + 32 * 4 + 8 * 3];
  for (let index = 0; index < numMarkets; index++) {
    const market = await marketPda(exchange, index);
    const { value } = await client.rpc.getAccountInfo(market, { encoding: 'base64' }).send();
    const data = Buffer.from(value!.data[0], 'base64');
    // symbol: after the discriminator, exchange pubkey and index byte.
    const symbol = data.subarray(41, 57).toString('utf8').replace(/\0+$/, '');
    const maxFunding = MARKETS.find((m) => m.symbol === symbol)?.maxFunding ?? 150_000n;
    await client.sendTransaction([
      await getConfigureMarketInstructionAsync({ admin: client.payer, exchange, market, maxHourlyFundingRate: maxFunding }),
    ]);
    console.log(`${symbol}: funding up to ${(Number(maxFunding) / 1e7).toFixed(4)}% / h (${data.length} byte account)`);
  }
}

async function faucet(wallet: string | undefined, amount = '10000') {
  if (!wallet) throw new Error('usage: npm run setup -- faucet <wallet> [amount]');
  const state = await loadPerpsState(client.rpc);
  if (!state) throw new Error('Exchange not initialized; run `npm run setup -- init` first');
  await client.sendTransaction(
    await getMintToATAInstructionPlanAsync({
      payer: client.payer,
      owner: address(wallet),
      mint: state.exchange.collateralMint,
      mintAuthority: client.payer,
      amount: BigInt(amount) * USD,
      decimals: 6,
    }),
  );
  console.log(`Minted ${amount} mock USDC to ${wallet}`);
}

async function seed(amount = '100000') {
  await faucet(client.payer.address, amount);
  const state = (await loadPerpsState(client.rpc))!;
  await client.sendTransaction(
    await liquidityIxs({ state, owner: client.payer, deposit: true, amount: BigInt(amount) * USD, minOut: 0n }),
  );
  const after = (await loadPerpsState(client.rpc))!;
  console.log(`Deposited ${amount} USDC as liquidity -> pool AUM $${formatUsd(poolAum(after))}`);
}

async function setOracle(oracle?: string) {
  if (!oracle) throw new Error('usage: set-oracle <address>');
  const state = await requireState();
  for (const m of state.markets) {
    if (m.data.oracleAuthority === oracle) {
      console.log(`${m.symbol} already uses ${oracle}`);
      continue;
    }
    await client.sendTransaction([
      getUpdateMarketInstruction({
        admin: client.payer,
        exchange: state.exchangeAddress,
        market: m.address,
        oracleAuthority: address(oracle),
        hourlyBorrowRate: m.data.hourlyBorrowRate,
        maxOpenInterest: m.data.maxOpenInterest,
      }),
    ]);
    console.log(`${m.symbol}: oracle authority ${m.data.oracleAuthority} -> ${oracle}`);
  }
}

async function requireState(): Promise<PerpsState> {
  const state = await loadPerpsState(client.rpc);
  if (!state) throw new Error('Exchange not initialized; run `npm run setup -- init` first');
  return state;
}

/** Make sure the admin holds at least `amount` mock USDC. */
async function ensureUsdc(state: PerpsState, amount: bigint) {
  const balance = await tokenBalance(client.rpc, client.payer.address, state.exchange.collateralMint);
  if (balance < amount) await faucet(client.payer.address, ((amount - balance) / USD + 1n).toString());
}

async function createPrediction(args: {
  question: string;
  oracleMarket?: (typeof MARKETS)[number]['symbol'];
  strike?: bigint;
  hours: number;
  yesPercent?: number;
  liquidity?: string;
}) {
  const state = await requireState();
  const liquidity = BigInt(args.liquidity ?? '1000') * USD;
  await ensureUsdc(state, liquidity);
  const market = args.oracleMarket ? state.markets.find((m) => m.symbol === args.oracleMarket) : undefined;
  if (args.oracleMarket && !market) throw new Error(`Unknown market ${args.oracleMarket}`);
  const id = newOrderId();
  const closeTime = BigInt(Math.floor(Date.now() / 1000 + args.hours * 3600));
  const question = market ? priceQuestion(market.symbol, args.strike!, closeTime) : args.question;
  await client.sendTransaction([
    await createPredictionIx({
      state,
      creator: client.payer,
      id,
      question,
      oracleMarket: market?.address,
      strike: args.strike ?? 0n,
      closeTime,
      liquidity,
      initialYesBps: Math.round((args.yesPercent ?? 50) * 100),
      feeBps: 100,
    }),
  ]);
  console.log(`Created ${await predictionPda(id)}: ${question}`);
}

async function predictPrice(symbol?: string, strike?: string, hours?: string, liquidity?: string) {
  if (!symbol || !strike || !hours) throw new Error('usage: predict-price <SYMBOL> <strike> <hours> [liquidity]');
  const s = symbol.toUpperCase().endsWith('-PERP') ? symbol.toUpperCase() : `${symbol.toUpperCase()}-PERP`;
  await createPrediction({ question: '', oracleMarket: s, strike: BigInt(Math.round(Number(strike) * 1e6)), hours: Number(hours), liquidity });
}

async function predictCustom(question?: string, hours?: string, yes?: string, liquidity?: string) {
  if (!question || !hours) throw new Error('usage: predict-custom "<question>" <hours> [yes%] [liquidity]');
  await createPrediction({ question, hours: Number(hours), yesPercent: yes ? Number(yes) : 50, liquidity });
}

async function predictDemo() {
  const state = await requireState();
  for (const market of state.markets) {
    // Strike at the current price, rounded to three significant figures: a near coin-flip.
    const price = Number(market.data.price) / 1e6;
    const step = 10 ** Math.max(0, Math.floor(Math.log10(price)) - 2);
    const strike = BigInt(Math.round(Math.round(price / step) * step * 1e6));
    await createPrediction({ question: '', oracleMarket: market.symbol, strike, hours: 24, liquidity: '2000' });
  }
  await createPrediction({
    question: 'Will Necxsoft Perps reach 100 unique devnet traders by Dec 5, 2026?',
    hours: (Date.UTC(2026, 11, 5) / 1000 - Date.now() / 1000) / 3600,
    yesPercent: 35,
    liquidity: '2000',
  });
  await createPrediction({
    question: 'Will Necxsoft Perps launch on Solana mainnet before Mar 1, 2027?',
    hours: (Date.UTC(2027, 2, 1) / 1000 - Date.now() / 1000) / 3600,
    yesPercent: 40,
    liquidity: '2000',
  });
}

async function predictResolve(market?: string, outcome?: string) {
  const outcomes: Record<string, Outcome> = { yes: Outcome.Yes, no: Outcome.No, invalid: Outcome.Invalid };
  if (!market || !outcome || !(outcome.toLowerCase() in outcomes)) throw new Error('usage: predict-resolve <market> yes|no|invalid');
  const state = await requireState();
  await client.sendTransaction([resolvePredictionIx(state, client.payer, address(market), outcomes[outcome.toLowerCase()])]);
  console.log(`Resolved ${market} ${outcome.toUpperCase()}`);
}

async function predictWithdraw(market?: string) {
  if (!market) throw new Error('usage: predict-withdraw <market>');
  const state = await requireState();
  const m = (await loadPredictions(client.rpc, state)).find((p) => p.address === market);
  if (!m?.data.resolved) throw new Error('Market not found or not resolved yet');
  await client.sendTransaction([await withdrawPredictionLiquidityIx(state, client.payer, address(market))]);
  console.log(`Withdrew pool liquidity and fees from ${market}`);
}
