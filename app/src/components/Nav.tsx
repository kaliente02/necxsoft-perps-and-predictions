import { useEffect, useRef, useState } from 'react';
import { useClient } from '@solana/react';
import {
  WalletReadyGate,
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useWallets,
} from '@solana/kit-plugin-wallet/react';
import { type AppClient, FAUCET_URL, NETWORK_LABEL, explorerTxUrl } from '../client';
import { useTx } from '../tx';
import { formatUsd } from '../lib/perps';

export type Page = 'trade' | 'predict' | 'earn';

function shorten(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function FaucetButton({ address, usdcBalance }: { address: string; usdcBalance: bigint | undefined }) {
  const { notify } = useTx();
  const [busy, setBusy] = useState(false);
  if (!FAUCET_URL) return null;
  return (
    <button
      className={`btn btn-small ${usdcBalance === 0n ? 'btn-primary' : 'btn-secondary'} faucet-btn`}
      disabled={busy}
      title="Get 1,000 test USDC (and a little devnet SOL for fees) once a day"
      onClick={async () => {
        setBusy(true);
        try {
          const response = await fetch(FAUCET_URL!, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ wallet: address }),
          });
          const body = (await response.json()) as { error?: string; usdc?: string; sol?: number; signature?: string };
          if (!response.ok) throw new Error(body.error ?? `Faucet error ${response.status}`);
          notify({
            kind: 'success',
            title: 'Test funds sent',
            body: `${body.usdc} USDC${body.sol ? ` and ${body.sol} SOL` : ''} are in your wallet.`,
            href: body.signature ? explorerTxUrl(body.signature) : undefined,
          });
        } catch (e) {
          notify({ kind: 'error', title: 'Test funds', body: (e as Error).message });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Sending…' : 'Get test USDC'}
    </button>
  );
}

function WalletButton({ usdcBalance }: { usdcBalance: bigint | undefined }) {
  const client = useClient<AppClient>();
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const connect = useConnect(client);
  const disconnect = useDisconnect(client);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  if (connected) {
    const address = connected.account.address;
    return (
      <div className="wallet" ref={ref}>
        <FaucetButton address={address} usdcBalance={usdcBalance} />
        <button className="btn btn-secondary wallet-trigger" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {connected.wallet.icon && <img src={connected.wallet.icon} alt="" width={18} height={18} />}
          <span className="wallet-address">{shorten(address)}</span>
          <span className="chevron" aria-hidden>▾</span>
        </button>
        {open && (
          <div className="menu" role="menu">
            <div className="menu-header">
              <span className="eyebrow">Connected with {connected.wallet.name}</span>
              <span className="mono">{shorten(address)}</span>
              {usdcBalance !== undefined && <span className="menu-balance">{formatUsd(usdcBalance)} USDC</span>}
            </div>
            <button
              role="menuitem"
              className="menu-item"
              onClick={() => {
                navigator.clipboard?.writeText(address).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'Address copied' : 'Copy address'}
            </button>
            <button
              role="menuitem"
              className="menu-item danger"
              onClick={() => {
                setOpen(false);
                disconnect.dispatch();
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet" ref={ref}>
      <button className="btn btn-primary" onClick={() => setOpen((o) => !o)} disabled={connect.isRunning} aria-expanded={open}>
        {connect.isRunning ? 'Connecting…' : 'Connect wallet'}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-header">
            <span className="eyebrow">Select a wallet</span>
          </div>
          {wallets.length === 0 && (
            <p className="menu-empty">No Solana wallet detected. Install Phantom, Solflare or Backpack, then refresh.</p>
          )}
          {wallets.map((wallet) => (
            <button
              key={wallet.name}
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                connect.dispatch(wallet);
              }}
            >
              <img src={wallet.icon} alt="" width={22} height={22} />
              {wallet.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Nav({
  page,
  usdcBalance,
  rpcHealthy,
}: {
  page: Page;
  usdcBalance: bigint | undefined;
  rpcHealthy: boolean;
}) {
  const client = useClient<AppClient>();
  return (
    <header className="navbar">
      <div className="navbar-inner">
        <a className="logo" href="#/trade" aria-label="Necxsoft Perps home">
          <img src={`${import.meta.env.BASE_URL}necxsoft-logo.png`} alt="" className="brand-logo" width={36} height={36} />
          <span className="brand-name">
            Necxsoft<span className="brand-product">Perps</span>
          </span>
        </a>
        <nav className="nav-links" aria-label="Primary">
          {(['trade', 'predict', 'earn'] as const).map((p) => (
            <a key={p} href={`#/${p}`} className={page === p ? 'active' : ''} aria-current={page === p ? 'page' : undefined}>
              {p === 'trade' ? 'Trade' : p === 'predict' ? 'Predict' : 'Earn'}
            </a>
          ))}
        </nav>
        <div className="nav-right">
          <span className={`network ${rpcHealthy ? 'ok' : 'down'}`} title={rpcHealthy ? 'RPC connected' : 'RPC unreachable'}>
            <span className="dot" aria-hidden />
            {NETWORK_LABEL}
          </span>
          {usdcBalance !== undefined && <span className="nav-balance">{formatUsd(usdcBalance)} USDC</span>}
          <WalletReadyGate client={client} fallback={<span className="btn btn-secondary skeleton-btn" aria-hidden />}>
            <WalletButton usdcBalance={usdcBalance} />
          </WalletReadyGate>
        </div>
      </div>
    </header>
  );
}
