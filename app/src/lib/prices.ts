import { parseUsd } from './perps';

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
