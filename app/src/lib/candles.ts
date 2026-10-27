import useSWR from 'swr';

export type Point = { t: number; p: number };
export type Range = '1H' | '4H' | '1D' | '1W';

const PRODUCTS: Record<string, string> = {
  'SOL-PERP': 'SOL-USD',
  'BTC-PERP': 'BTC-USD',
  'ETH-PERP': 'ETH-USD',
};

// Coinbase granularity (seconds) and window per range; each fits in one 300-candle request.
const RANGES: Record<Range, { granularity: number; seconds: number }> = {
  '1H': { granularity: 60, seconds: 3_600 },
  '4H': { granularity: 300, seconds: 14_400 },
  '1D': { granularity: 900, seconds: 86_400 },
  '1W': { granularity: 3_600, seconds: 604_800 },
};

export const RANGE_OPTIONS = Object.keys(RANGES) as Range[];

/** Close prices from Coinbase's public candles API — the same reference source the keeper pushes on-chain. */
async function fetchCandles(symbol: string, range: Range): Promise<Point[]> {
  const product = PRODUCTS[symbol];
  if (!product) return [];
  const { granularity, seconds } = RANGES[range];
  const end = Math.floor(Date.now() / 1000);
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularity}&start=${end - seconds}&end=${end}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`candles ${response.status}`);
  // [time, low, high, open, close, volume], newest first
  const rows = (await response.json()) as number[][];
  return rows.map((r) => ({ t: r[0], p: r[4] })).reverse();
}

export function useCandles(symbol: string, range: Range) {
  return useSWR(['candles', symbol, range], () => fetchCandles(symbol, range), {
    refreshInterval: 60_000,
    keepPreviousData: true,
  });
}

export type DayStats = { open: number; high: number; low: number };

export function dayStats(points: Point[] | undefined): DayStats | null {
  if (!points?.length) return null;
  const prices = points.map((pt) => pt.p);
  return { open: prices[0], high: Math.max(...prices), low: Math.min(...prices) };
}
