import os from 'node:os';
import path from 'node:path';
import { createClient } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';

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

export { PRICE_SOURCES, fetchPrices } from '../src/lib/prices';
