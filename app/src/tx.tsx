import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useSWRConfig } from 'swr';
import type { Instruction, TransactionSigner } from '@solana/kit';
import { useAction, useClient } from '@solana/react';
import { type AppClient, clientV0, explorerTxUrl } from './client';

type Toast = { id: number; kind: 'pending' | 'success' | 'error'; title: string; body?: string; href?: string };

type Build = (signer: TransactionSigner) => Promise<Instruction[]>;

type TxContextValue = {
  run: (label: string, build: Build) => void;
  isRunning: boolean;
  /** Show a toast for work that isn't a wallet transaction (e.g. the faucet). */
  notify: (toast: Omit<Toast, 'id'>) => void;
};

const TxContext = createContext<TxContextValue | null>(null);

// Friendly copies of the program's errors (codes 6000+), kept here so production bundles have them too.
const PROGRAM_ERRORS: Record<number, string> = {
  6006: 'Oracle price is stale — the keeper may be offline.',
  6007: 'Price moved beyond your slippage tolerance.',
  6008: 'The exchange is paused.',
  6009: 'Amount must be greater than zero.',
  6010: 'Collateral is below the exchange minimum.',
  6011: 'Position exceeds the maximum leverage.',
  6012: 'Position would be below maintenance margin.',
  6013: 'Market open-interest cap reached.',
  6014: 'Pool utilization cap reached — not enough liquidity.',
  6015: 'Pool does not have enough liquidity.',
  6018: 'Output is below the minimum requested.',
  6021: 'The trigger price has not been reached yet.',
  6022: 'Invalid order.',
  6023: 'To close the whole position, use Close.',
  6026: 'This market is closed for trading.',
  6027: 'This market has not been resolved yet.',
  6028: 'This market cannot be resolved yet.',
  6030: 'You do not hold that many shares.',
};

function describeError(error: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const context = (current as { context?: Record<string, unknown> }).context;
    const code = context?.code ?? context?.customErrorCode;
    if (typeof code === 'number' && PROGRAM_ERRORS[code]) return PROGRAM_ERRORS[code];
    const text = (current as Error).message ?? '';
    if (/reject/i.test(text)) return 'You rejected the request in your wallet.';
    if (/insufficient (funds|lamports)/i.test(text)) return 'Not enough SOL to pay fees or rent.';
    if (/blockhash/i.test(text)) return 'Transaction expired before it landed. Try again.';
    if ((current as Error).message) message = (current as Error).message;
    current = (current as { cause?: unknown }).cause;
  }
  return message;
}

export function TxProvider({ children }: { children: ReactNode }) {
  const client = useClient<AppClient>();
  const { mutate } = useSWRConfig();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const upsert = useCallback((toast: Toast) => {
    setToasts((all) => [...all.filter((t) => t.id !== toast.id), toast]);
    if (toast.kind !== 'pending') {
      setTimeout(() => setToasts((all) => all.filter((t) => t.id !== toast.id)), 8_000);
    }
  }, []);

  const action = useAction(async (signal: AbortSignal, label: string, build: Build) => {
    const id = nextId.current++;
    const connected = client.wallet.getState().connected;
    if (!connected) {
      upsert({ id, kind: 'error', title: label, body: 'Connect a wallet first.' });
      return;
    }
    // v1 by default; wallets that can't sign v1 go through the v0 stack.
    const sender = connected.supportedTransactionVersions.has(1) ? client : clientV0;
    upsert({ id, kind: 'pending', title: label, body: 'Simulating, then approve in your wallet…' });
    try {
      const instructions = await build(client.payer);
      // The planner simulates to size compute limits, so program errors surface here, before signing.
      const result = await sender.sendTransaction(instructions, { abortSignal: signal });
      const signature = result.context.signature;
      upsert({ id, kind: 'success', title: label, body: 'Confirmed', href: explorerTxUrl(signature) });
    } catch (error) {
      if (signal.aborted) return;
      console.error(error);
      upsert({ id, kind: 'error', title: `${label} failed`, body: describeError(error) });
    } finally {
      await mutate(() => true);
    }
  });

  const run = useCallback((label: string, build: Build) => action.dispatch(label, build), [action.dispatch]);
  const notify = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      upsert({ ...toast, id: nextId.current++ });
      if (toast.kind === 'success') mutate(() => true);
    },
    [upsert, mutate],
  );

  return (
    <TxContext.Provider value={{ run, isRunning: action.isRunning, notify }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <strong>{t.title}</strong>
            {t.body && <span>{t.body}</span>}
            {t.href && (
              <a href={t.href} target="_blank" rel="noreferrer">
                View on explorer ↗
              </a>
            )}
            {t.kind !== 'pending' && (
              <button
                className="toast-close"
                aria-label="Dismiss"
                onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </TxContext.Provider>
  );
}

export function useTx(): TxContextValue {
  const value = useContext(TxContext);
  if (!value) throw new Error('useTx must be used inside <TxProvider>');
  return value;
}
