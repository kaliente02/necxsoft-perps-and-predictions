// Runs the keeper (src/lib/keeper.ts) locally in a loop, as the KEYPAIR wallet.
//
//   npm run keeper
import { createKeeper } from '../src/lib/keeper';
import { createScriptClient } from './common';

const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 10_000);
const client = await createScriptClient();
const keeper = createKeeper(client, {
  rollHours: Number(process.env.ROLL_HOURS ?? 4),
  rollLiquidity: BigInt(process.env.ROLL_LIQUIDITY ?? 2_000) * 1_000_000n,
});

console.log(`Keeper running as ${client.payer.address} every ${INTERVAL_MS}ms`);
for (;;) {
  try {
    await keeper.tick();
  } catch (e) {
    console.error('tick failed:', (e as Error).message);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
