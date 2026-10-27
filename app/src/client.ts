import { createClient } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { walletSigner } from '@solana/kit-plugin-wallet';

export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8899';
export const CHAIN = (import.meta.env.VITE_CHAIN ?? 'solana:localnet') as `solana:${string}`;

// One wallet connection shared by two RPC stacks: v1 transactions by default, and a
// v0 fallback for wallets that don't sign v1 yet (all perps transactions fit in 1232 bytes).
const walletClient = createClient().use(walletSigner({ chain: CHAIN }));
export const client = walletClient.use(solanaRpc({ rpcUrl: RPC_URL, transactionConfig: { version: 1 } }));
export const clientV0 = walletClient.use(solanaRpc({ rpcUrl: RPC_URL, transactionConfig: { version: 0 } }));

export type AppClient = Awaited<typeof client>;

export function explorerTxUrl(signature: string): string {
  const base = `https://explorer.solana.com/tx/${signature}`;
  if (CHAIN === 'solana:mainnet') return base;
  if (CHAIN === 'solana:devnet' || CHAIN === 'solana:testnet') return `${base}?cluster=${CHAIN.slice(7)}`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`;
}

export const NETWORK_LABEL = CHAIN.replace('solana:', '');

/** Devnet faucet served by the Worker (worker/index.ts); unset on other clusters. */
export const FAUCET_URL: string | undefined =
  import.meta.env.VITE_FAUCET_URL || (CHAIN === 'solana:devnet' ? 'https://necxsoft.com/perps-and-predictions/api/faucet' : undefined);
