// On-chain market history: the hourly samples `update_price` records per market and the
// exchange-wide liquidation feed `liquidate` appends to. Both are single fixed-size accounts, so
// one RPC call loads each — no transaction scanning.
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import {
  type HourlySample,
  type LiquidationRecord,
  fetchMaybeLiquidationFeed,
  fetchMaybeMarketHistory,
  findHistoryPda,
  findLiquidationFeedPda,
} from '../generated';
import { type Market, Side } from './perps';

export type { HourlySample, LiquidationRecord };

/** Read a ring buffer oldest first. */
function ordered<T>(items: T[], head: number, count: number): T[] {
  const start = count < items.length ? 0 : head;
  return Array.from({ length: count }, (_, i) => items[(start + i) % items.length]);
}

/** The market's hourly samples, oldest first (empty before the market was configured). */
export async function loadMarketHistory(rpc: Rpc<SolanaRpcApi>, market: Address): Promise<HourlySample[]> {
  const [pda] = await findHistoryPda({ market });
  const account = await fetchMaybeMarketHistory(rpc, pda);
  if (!account.exists) return [];
  return ordered(account.data.samples, account.data.head, account.data.count);
}

export type Liquidation = Omit<LiquidationRecord, 'side' | 'padding'> & { side: Side };

/** The exchange's most recent liquidations, newest first. */
export async function loadLiquidations(rpc: Rpc<SolanaRpcApi>): Promise<Liquidation[]> {
  const [pda] = await findLiquidationFeedPda();
  const account = await fetchMaybeLiquidationFeed(rpc, pda);
  if (!account.exists) return [];
  return ordered(account.data.records, account.data.head, account.data.count)
    .reverse()
    .map(({ side, padding: _, ...r }) => ({ ...r, side: side === 0 ? Side.Long : Side.Short }));
}

export type FundingBar = {
  start: number;
  end: number;
  /** Average hourly funding rate over the interval (BORROW_RATE_SCALE, + = longs pay). */
  rate: bigint;
  longOpenInterest: bigint;
  shortOpenInterest: bigint;
};

/**
 * Realized funding per interval between samples, from differences of the cumulative funding
 * index, ending with the interval from the last sample to now at the live rate.
 */
export function fundingBars(samples: HourlySample[], market: Market, nowSecs: bigint): FundingBar[] {
  const bars: FundingBar[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const seconds = b.time - a.time;
    if (seconds <= 0n) continue;
    bars.push({
      start: Number(a.time),
      end: Number(b.time),
      rate: ((b.cumulativeFundingIndex - a.cumulativeFundingIndex) * 3600n) / seconds,
      longOpenInterest: a.longOpenInterest,
      shortOpenInterest: a.shortOpenInterest,
    });
  }
  const last = samples[samples.length - 1];
  if (last && nowSecs > last.time) {
    // Live interval: accrue the index to now the way the program would.
    const elapsed = nowSecs - market.lastBorrowUpdate;
    const index = market.cumulativeFundingIndex + (elapsed > 0n ? (market.fundingRate * elapsed) / 3600n : 0n);
    bars.push({
      start: Number(last.time),
      end: Number(nowSecs),
      rate: ((index - last.cumulativeFundingIndex) * 3600n) / (nowSecs - last.time),
      longOpenInterest: market.longOpenInterest,
      shortOpenInterest: market.shortOpenInterest,
    });
  }
  return bars;
}
