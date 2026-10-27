import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { fetchMint } from '@solana-program/token';
import { useClient } from '@solana/react';
import type { AppClient } from './client';
import { AccountSummary } from './components/AccountSummary';
import { Footer } from './components/Footer';
import { Nav, type Page } from './components/Nav';
import { OrderBook } from './components/OrderBook';
import { OrderPanel } from './components/OrderPanel';
import { Positions } from './components/Positions';
import { PriceChart } from './components/PriceChart';
import { TickerBar } from './components/TickerBar';
import { useHistory, useNowSecs, useOrders, useOwner, usePerpsState, usePositions, useTokenBalance } from './hooks';
import { Earn } from './pages/Earn';
import { Predict } from './pages/Predict';

function pageFromHash(): Page {
  const hash = window.location.hash;
  return hash.startsWith('#/earn') ? 'earn' : hash.startsWith('#/predict') ? 'predict' : 'trade';
}

function usePage(): Page {
  const [page, setPage] = useState(pageFromHash);
  useEffect(() => {
    const onChange = () => {
      setPage(pageFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return page;
}

export function App() {
  const { rpc } = useClient<AppClient>();
  const page = usePage();
  const { data: state, error, isLoading } = usePerpsState();
  const owner = useOwner();
  const now = useNowSecs();
  const positions = usePositions(state, owner).data ?? [];
  const orders = useOrders(owner).data ?? [];
  const history = useHistory(owner);
  const usdcBalance = useTokenBalance(owner, state?.exchange.collateralMint);
  const lpSupply = useSWR(
    state ? ['lp-supply', state.exchange.lpMint] : null,
    async () => (await fetchMint(rpc, state!.exchange.lpMint)).data.supply,
    { refreshInterval: 5_000 },
  ).data;
  const [selected, setSelected] = useState<string | null>(null);

  const market = state?.markets.find((m) => m.address === selected) ?? state?.markets[0];

  let content;
  if (!state || !market) {
    content = (
      <div className="setup card">
        {isLoading ? (
          <>
            <span className="spinner" aria-hidden />
            <p className="faint">Connecting to the exchange…</p>
          </>
        ) : (
          <>
            <span className="eyebrow">Setup required</span>
            <h1>{state ? 'No markets listed yet' : 'Exchange not found'}</h1>
            <p className="faint">
              {error
                ? `Could not reach the RPC endpoint: ${String(error.message ?? error)}`
                : 'The Necxsoft Perps program has not been initialized on this cluster. Run the following from the repository root:'}
            </p>
            <pre className="code">{`anchor build && anchor deploy
cd app && npm run setup -- init
npm run keeper`}</pre>
          </>
        )}
      </div>
    );
  } else if (page === 'predict') {
    content = <Predict state={state} owner={owner} usdcBalance={usdcBalance} now={now} />;
  } else if (page === 'earn') {
    content = <Earn state={state} owner={owner} usdcBalance={usdcBalance} lpSupply={lpSupply} />;
  } else {
    content = (
      <div className="trade">
        <TickerBar state={state} market={market} now={now} onSelect={setSelected} />
        <div className="trade-grid">
          <div className="trade-main">
            <div className="chart-row">
              <PriceChart symbol={market.symbol} markPrice={Number(market.data.price) / 1e6} />
              <OrderBook market={market} owner={owner} />
            </div>
            <Positions
              state={state}
              positions={positions}
              orders={orders}
              history={history.data ?? []}
              historyLoading={history.isLoading}
              now={now}
              connected={!!owner}
              usdcBalance={usdcBalance}
            />
          </div>
          <div className="trade-side">
            <OrderPanel state={state} market={market} positions={positions} usdcBalance={usdcBalance} connected={!!owner} />
            <AccountSummary state={state} positions={positions} usdcBalance={usdcBalance} now={now} connected={!!owner} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Nav page={page} usdcBalance={usdcBalance} rpcHealthy={!error} />
      {state?.exchange.paused && (
        <div className="banner" role="alert">
          Trading is temporarily paused by the exchange. Open positions can still be closed.
        </div>
      )}
      <main className="main">{content}</main>
      <Footer />
    </div>
  );
}
