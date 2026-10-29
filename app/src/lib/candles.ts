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

/** Granularities Coinbase accepts, finest first. */
const GRANULARITIES = [60, 300, 900, 3_600, 21_600, 86_400];
const MAX_CANDLES = 300;

/** Close prices from Coinbase's public candles API — the same reference source the keeper pushes on-chain. */
async function fetchCandles(symbol: string, granularity: number, start: number, end: number): Promise<Point[]> {
  const product = PRODUCTS[symbol];
  if (!product) return [];
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularity}&start=${start}&end=${end}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`candles ${response.status}`);
  // [time, low, high, open, close, volume], newest first
  const rows = (await response.json()) as number[][];
  return rows.map((r) => ({ t: r[0], p: r[4] })).reverse();
}

export function useCandles(symbol: string, range: Range) {
  return useSWR(
    ['candles', symbol, range],
    () => {
      const { granularity, seconds } = RANGES[range];
      const end = Math.floor(Date.now() / 1000);
      return fetchCandles(symbol, granularity, end - seconds, end);
    },
    { refreshInterval: 60_000, keepPreviousData: true },
  );
}

export type DetailCandles = { start: number; end: number; points: Point[] };

/**
 * Finer candles for a zoomed-in window: picks the finest granularity that covers the window in
 * one request, and skips the fetch when that isn't finer than the range's own candles.
 */
export function useDetailCandles(symbol: string, range: Range, window: { start: number; end: number } | null) {
  const granularity = window ? GRANULARITIES.find((g) => (window.end - window.start) / g <= MAX_CANDLES) : undefined;
  const useful = window && granularity && granularity < RANGES[range].granularity;
  // Snap to the granularity so small pans reuse the cached request.
  const start = useful ? Math.floor(window.start / granularity) * granularity : 0;
  const end = useful ? Math.ceil(window.end / granularity) * granularity : 0;
  return useSWR<DetailCandles>(useful ? ['detail', symbol, granularity, start, end] : null, async () => ({
    start,
    end,
    points: await fetchCandles(symbol, granularity!, start, end),
  }));
}

export type DayStats = { open: number; high: number; low: number };

export function dayStats(points: Point[] | undefined): DayStats | null {
  if (!points?.length) return null;
  const prices = points.map((pt) => pt.p);
  return { open: prices[0], high: Math.max(...prices), low: Math.min(...prices) };
}
