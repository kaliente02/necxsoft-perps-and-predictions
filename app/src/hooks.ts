import { useEffect, useState } from 'react';
import useSWR from 'swr';
import type { Address } from '@solana/kit';
import { useClient } from '@solana/react';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import type { AppClient } from './client';
import { type PerpsState, loadHistory, loadMarketTrades, loadOrders, loadPerpsState, loadPositions, tokenBalance } from './lib/perps';
import { loadLiquidations, loadMarketHistory } from './lib/history';
import { loadFlows } from './lib/portfolio';
import { loadPredictionPositions, loadPredictionResults, loadPredictions, loadProbabilityHistory } from './lib/predict';

const REFRESH_MS = 3_000;

export function usePerpsState() {
  const { rpc } = useClient<AppClient>();
  return useSWR('perps-state', () => loadPerpsState(rpc), { refreshInterval: REFRESH_MS });
}

export function useOwner(): Address | null {
  const client = useClient<AppClient>();
  const connected = useConnectedWallet(client);
  return (connected?.account.address as Address | undefined) ?? null;
}

export function usePositions(state: PerpsState | null | undefined, owner: Address | null) {
  const { rpc } = useClient<AppClient>();
  return useSWR(
    state && owner ? ['positions', owner, state.markets.length] : null,
    () => loadPositions(rpc, state!, owner!),
    { refreshInterval: REFRESH_MS },
  );
}

export function useOrders(owner: Address | null) {
  const { rpc } = useClient<AppClient>();
  return useSWR(owner ? ['orders', owner] : null, () => loadOrders(rpc, owner!), { refreshInterval: REFRESH_MS });
}

export function useHistory(owner: Address | null) {
  const { rpc } = useClient<AppClient>();
  return useSWR(owner ? ['history', owner] : null, () => loadHistory(rpc, owner!), { refreshInterval: 15_000 });
}

/** USDC paid and received per product, for the portfolio's profit and loss. */
export function useFlows(owner: Address | null, mint: Address | undefined) {
  const { rpc } = useClient<AppClient>();
  return useSWR(owner && mint ? ['flows', owner, mint] : null, () => loadFlows(rpc, owner!, mint!), { refreshInterval: 15_000 });
}

export function useTokenBalance(owner: Address | null, mint: Address | undefined) {
  const { rpc } = useClient<AppClient>();
  return useSWR(owner && mint ? ['balance', owner, mint] : null, () => tokenBalance(rpc, owner!, mint!), {
    refreshInterval: REFRESH_MS,
  }).data;
}

/** Wall-clock seconds as bigint, ticking once per second (for borrow-fee accrual and price age). */
export function useNowSecs(): bigint {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const id = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function usePredictions(state: PerpsState | null | undefined) {
  const { rpc } = useClient<AppClient>();
  return useSWR(state ? ['predictions', state.markets.length] : null, () => loadPredictions(rpc, state!), {
    refreshInterval: 5_000,
  });
}

export function usePredictionPositions(owner: Address | null) {
  const { rpc } = useClient<AppClient>();
  return useSWR(owner ? ['prediction-positions', owner] : null, () => loadPredictionPositions(rpc, owner!), {
    refreshInterval: REFRESH_MS,
  });
}

export function useProbabilityHistory(market: Address | undefined) {
  const { rpc } = useClient<AppClient>();
  return useSWR(market ? ['probability', market] : null, () => loadProbabilityHistory(rpc, market!), {
    refreshInterval: 15_000,
  });
}

/** Every trader's resting orders, for the order book. */
export function useAllOrders() {
  const { rpc } = useClient<AppClient>();
  return useSWR('all-orders', () => loadOrders(rpc), { refreshInterval: 5_000 });
}

export function useMarketTrades(market: Address | undefined) {
  const { rpc } = useClient<AppClient>();
  return useSWR(market ? ['market-trades', market] : null, () => loadMarketTrades(rpc, market!), { refreshInterval: 10_000 });
}

/** A market's on-chain hourly samples (funding, open interest, price). */
export function useMarketHistory(market: Address | undefined) {
  const { rpc } = useClient<AppClient>();
  return useSWR(market ? ['market-history', market] : null, () => loadMarketHistory(rpc, market!), { refreshInterval: 60_000 });
}

/** The exchange's recent liquidations, from the on-chain feed. */
export function useLiquidations() {
  const { rpc } = useClient<AppClient>();
  return useSWR('liquidations', () => loadLiquidations(rpc), { refreshInterval: 10_000 });
}

/** The owner's prediction results per market, including redeemed (closed) positions. */
export function usePredictionResults(owner: Address | null) {
  const { rpc } = useClient<AppClient>();
  return useSWR(owner ? ['prediction-results', owner] : null, () => loadPredictionResults(rpc, owner!), { refreshInterval: 30_000 });
}
