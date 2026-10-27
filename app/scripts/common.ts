import os from 'node:os';
import path from 'node:path';
import { createClient } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';
import { parseUsd } from '../src/lib/perps';

export const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const KEYPAIR = (process.env.KEYPAIR ?? '~/.config/solana/id.json').replace(/^~/, os.homedir());
// Transaction v1 needs a cluster with SIMD-0385 active (devnet, mainnet, recent surfpool). Set TX_VERSION=0 otherwise.
const TX_VERSION = process.env.TX_VERSION === '0' ? 0 : 1;

export async function createScriptClient() {
  return createClient()
    .use(await signerFromFile(path.resolve(KEYPAIR)))
    .use(
      solanaRpc({
        rpcUrl: RPC_URL,
        transactionConfig: TX_VERSION === 1 ? { version: 1 } : { version: 0 },
      }),
    );
}

export type ScriptClient = Awaited<ReturnType<typeof createScriptClient>>;

/**
 * Reference prices for the demo oracle, from Coinbase's public spot API (no API key needed).
 * For production, replace the keeper-pushed price with an on-chain pull oracle (e.g. Pyth) read
 * inside the program, so traders don't have to trust the oracle authority.
 */
export const PRICE_SOURCES: Record<string, string> = {
  'SOL-PERP': 'SOL-USD',
  'BTC-PERP': 'BTC-USD',
  'ETH-PERP': 'ETH-USD',
};

/** Latest spot prices converted to 6-decimal USD, keyed by market symbol. */
export async function fetchPrices(symbols: string[]): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  await Promise.all(
    symbols
      .filter((symbol) => PRICE_SOURCES[symbol])
      .map(async (symbol) => {
        const response = await fetch(`https://api.coinbase.com/v2/prices/${PRICE_SOURCES[symbol]}/spot`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`price API ${response.status} for ${symbol}`);
        const body = (await response.json()) as { data: { amount: string } };
        const price = parseUsd(body.data.amount);
        if (!price) throw new Error(`bad price for ${symbol}: ${body.data.amount}`);
        out[symbol] = price;
      }),
  );
  return out;
}
