// End-to-end smoke test against a running cluster, using the same helpers as the web app.
// Requires `npm run setup -- init`, a funded admin USDC account (`npm run setup -- faucet <admin>`),
// and the keeper running (`npm run keeper`) for fresh prices and order fills.
//
//   npm run smoke
import { fetchMint } from '@solana-program/token';
import {
  BPS,
  OrderKind,
  Side,
  USD,
  closePositionIxs,
  decreasePositionIxs,
  formatUsd,
  increasePositionIxs,
  liquidityIxs,
  loadHistory,
  loadOrders,
  loadPerpsState,
  loadPositions,
  placeOrderIx,
  poolAum,
  tokenBalance,
} from '../src/lib/perps';
import {
  Outcome,
  buySharesIxs,
  createPredictionIx,
  loadPredictionPositions,
  loadPredictions,
  predictionPda,
  predictionVaultPda,
  quoteBuy,
  quoteSell,
  redeemIxs,
  resolvePredictionIx,
  sellSharesIxs,
  withdrawPredictionLiquidityIx,
} from '../src/lib/predict';
import { createScriptClient } from './common';

let idCounter = BigInt(Date.now()) * 1000n;
const newId = () => ++idCounter;

async function waitFor(what: string, done: () => Promise<boolean>, timeoutMs = 60_000) {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}; is the keeper running?`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

const client = await createScriptClient();
const owner = client.payer;
let state = (await loadPerpsState(client.rpc))!;
if (!state) throw new Error('Exchange not initialized');
const mint = state.exchange.collateralMint;
const usdc = () => tokenBalance(client.rpc, owner.address, mint);

console.log(`USDC before: ${formatUsd(await usdc())}`);

// 1. LP deposit
await client.sendTransaction(await liquidityIxs({ state, owner, deposit: true, amount: 20_000n * USD, minOut: 0n }));
state = (await loadPerpsState(client.rpc))!;
console.log(`Deposited 20,000 USDC -> pool AUM $${formatUsd(poolAum(state))}`);

// 2. Open a 10x SOL long
const market = state.markets.find((m) => m.symbol === 'SOL-PERP')!;
const price = market.data.price;
await client.sendTransaction(
  await increasePositionIxs({
    state,
    owner,
    market: market.address,
    side: Side.Long,
    collateral: 100n * USD,
    sizeUsd: 1_000n * USD,
    priceLimit: (price * (BPS + 100n)) / BPS,
  }),
);
let positions = await loadPositions(client.rpc, state, owner.address);
const position = positions.find((p) => p.market.address === market.address && p.data.side === Side.Long)!;
console.log(
  `Opened long: size $${formatUsd(position.data.sizeUsd)} collateral $${formatUsd(position.data.collateral)} entry $${formatUsd(position.data.entryPrice)}`,
);

// 3. Close 40% of it, withdrawing collateral in proportion
await client.sendTransaction(
  await decreasePositionIxs({
    state,
    owner,
    position,
    sizeUsd: 400n * USD,
    collateralOut: (position.data.collateral * 400n) / 1_000n,
    priceLimit: (price * (BPS - 100n)) / BPS,
  }),
);
positions = await loadPositions(client.rpc, state, owner.address);
const reduced = positions.find((p) => p.address === position.address)!;
if (reduced.data.sizeUsd !== 600n * USD) throw new Error(`Partial close left size ${reduced.data.sizeUsd}`);
console.log(`Closed 40%: size $${formatUsd(reduced.data.sizeUsd)} collateral $${formatUsd(reduced.data.collateral)}`);

// 4. Close the rest with a stop-loss the keeper fills (keeper must be running)
state = (await loadPerpsState(client.rpc))!;
await client.sendTransaction([
  await placeOrderIx({
    state,
    owner,
    market: market.address,
    side: Side.Long,
    kind: OrderKind.StopLoss,
    triggerPrice: price * 2n, // already crossed: a long's stop fills at or below its trigger
    sizeUsd: 0n,
    collateral: 0n,
  }),
]);
await waitFor('stop-loss fill', async () => (await loadPositions(client.rpc, state, owner.address)).length === 0);
console.log('Stop-loss filled by the keeper; position closed');

// 5. Open via a limit order the keeper fills, then close it
await client.sendTransaction([
  await placeOrderIx({
    state,
    owner,
    market: market.address,
    side: Side.Short,
    kind: OrderKind.Limit,
    triggerPrice: price / 2n, // already crossed: a short limit fills at or above its trigger
    sizeUsd: 500n * USD,
    collateral: 50n * USD,
  }),
]);
await waitFor('limit fill', async () => (await loadPositions(client.rpc, state, owner.address)).length === 1);
state = (await loadPerpsState(client.rpc))!;
positions = await loadPositions(client.rpc, state, owner.address);
const short = positions[0];
console.log(`Limit order filled by the keeper: short $${formatUsd(short.data.sizeUsd)} at $${formatUsd(short.data.entryPrice)}`);
const closePrice = state.markets.find((m) => m.address === market.address)!.data.price;
await client.sendTransaction(
  await closePositionIxs({ state, owner, position: short, priceLimit: (closePrice * (BPS + 100n)) / BPS }),
);
if ((await loadOrders(client.rpc, owner.address)).length !== 0) throw new Error('Orders left open');

// 6. History is rebuilt from program events
const history = await loadHistory(client.rpc, owner.address);
console.log(`History: ${history.map((h) => h.event.type).join(', ')}`);
for (const type of ['increase', 'decrease', 'order-placed', 'order-executed', 'close']) {
  if (!history.some((h) => h.event.type === type)) throw new Error(`History is missing a ${type} event`);
}

// 7. Withdraw all LP
const lpMint = await fetchMint(client.rpc, state.exchange.lpMint);
const lpBalance = await tokenBalance(client.rpc, owner.address, state.exchange.lpMint);
state = (await loadPerpsState(client.rpc))!;
await client.sendTransaction(await liquidityIxs({ state, owner, deposit: false, amount: lpBalance, minOut: 0n }));
console.log(`Withdrew ${formatUsd(lpBalance)} of ${formatUsd(lpMint.data.supply)} NLP`);

// 8. Prediction markets: a custom question and a price market the keeper resolves
const predictionVaultBalance = async (m: Awaited<ReturnType<typeof loadPredictions>>[number]) =>
  BigInt((await client.rpc.getTokenAccountBalance(await predictionVaultPda(m.address)).send()).value.amount);
state = (await loadPerpsState(client.rpc))!;
const nowSecs = BigInt(Math.floor(Date.now() / 1000));
const customId = newId();
const priceId = newId();
await client.sendTransaction([
  await createPredictionIx({
    state, creator: owner, id: customId, question: 'Smoke test: will this pass?', strike: 0n,
    closeTime: nowSecs + 3_600n, liquidity: 1_000n * USD, initialYesBps: 6_000, feeBps: 100,
  }),
  await createPredictionIx({
    state, creator: owner, id: priceId, question: 'Smoke test: SOL above zero?', oracleMarket: market.address,
    strike: 1n, closeTime: nowSecs + 20n, liquidity: 500n * USD, initialYesBps: 5_000, feeBps: 0,
  }),
]);
const findPrediction = async (id: bigint) => {
  const address = await predictionPda(id);
  return (await loadPredictions(client.rpc, state)).find((p) => p.address === address)!;
};
let custom = await findPrediction(customId);
const quote = quoteBuy(custom.data, Outcome.Yes, 100n * USD)!;
await client.sendTransaction(
  await buySharesIxs({ state, owner, market: custom.address, outcome: Outcome.Yes, amount: 100n * USD, minShares: quote.shares }),
);
let mine = (await loadPredictionPositions(client.rpc, owner.address)).find((p) => p.data.market === custom.address)!;
if (mine.data.yesShares !== quote.shares) throw new Error(`Bought ${mine.data.yesShares} shares, quoted ${quote.shares}`);
console.log(`Bought ${formatUsd(quote.shares)} YES for $100 (avg ${Number(quote.avgPriceBps) / 100}¢)`);
custom = await findPrediction(customId);
const sellQuote = quoteSell(custom.data, Outcome.Yes, quote.shares / 4n)!;
await client.sendTransaction(
  await sellSharesIxs({ state, owner, market: custom.address, outcome: Outcome.Yes, shares: quote.shares / 4n, minOut: sellQuote.amount }),
);
custom = await findPrediction(customId);
if ((await predictionVaultBalance(custom)) !== custom.data.totalSets + custom.data.fees) throw new Error('Prediction vault not backed');
await client.sendTransaction([resolvePredictionIx(state, owner, custom.address, Outcome.Yes)]);
mine = (await loadPredictionPositions(client.rpc, owner.address)).find((p) => p.data.market === custom.address)!;
const beforeRedeem = await usdc();
await client.sendTransaction(await redeemIxs(state, owner, custom.address));
if ((await usdc()) - beforeRedeem !== mine.data.yesShares) throw new Error('Redeem paid the wrong amount');
await client.sendTransaction([await withdrawPredictionLiquidityIx(state, owner, custom.address)]);
custom = await findPrediction(customId);
if ((await predictionVaultBalance(custom)) !== 0n) throw new Error('Custom market vault not drained');
console.log('Custom market: traded, resolved YES, redeemed and drained');

await client.sendTransaction(
  await buySharesIxs({ state, owner, market: await predictionPda(priceId), outcome: Outcome.No, amount: 10n * USD, minShares: 0n }),
);
await waitFor('price market resolution', async () => (await findPrediction(priceId)).data.resolved, 120_000);
const priced = await findPrediction(priceId);
if (priced.data.outcome !== Outcome.Yes) throw new Error('Price market should resolve YES');
console.log(`Price market resolved ${priced.data.outcome === Outcome.Yes ? 'YES' : 'NO'} at $${formatUsd(priced.data.resolvedPrice)} by the keeper`);
await client.sendTransaction(await redeemIxs(state, owner, priced.address));

// 9. Solvency: vault == pool + trader collateral
state = (await loadPerpsState(client.rpc))!;
const { value: vault } = await client.rpc.getTokenAccountBalance(state.exchange.vault).send();
const expected = state.exchange.poolBalance + state.exchange.totalCollateral;
console.log(`USDC after: ${formatUsd(await usdc())}`);
if (BigInt(vault.amount) !== expected) throw new Error(`Vault ${vault.amount} != ${expected}`);
console.log('Smoke test passed: vault balance == pool + collateral');
