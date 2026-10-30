// Cloudflare Worker behind necxsoft.com/perps-and-predictions/*:
//  - serves the built web app (static assets)
//  - runs the keeper on a one-minute cron, ticking every TICK_MS within each run; as the markets'
//    oracle authority it also opens the rolling price prediction markets, seeded from its USDC
//  - POST /perps-and-predictions/api/faucet {wallet}: devnet test USDC (+ a little SOL for fees)
//
// Secrets:  KEEPER_SECRET_KEY  (JSON byte array of the keeper keypair; wrangler secret put)
//           RPC_URL            (devnet RPC with an API key; the public endpoint blocks Workers)
import { type Address, createClient, createKeyPairSignerFromBytes, isAddress, lamports } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import { getTransferSolInstruction } from '@solana-program/system';
import { getTransferInstruction } from '@solana-program/token';
import { createKeeper } from '../src/lib/keeper';
import { USD, ata, createAtaIx, formatUsd, loadPerpsState, tokenBalance } from '../src/lib/perps';

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type Env = {
  ASSETS: Fetcher;
  FAUCET: KVNamespace;
  KEEPER_SECRET_KEY: string;
  RPC_URL: string;
};

const TICK_MS = 30_000;
/**
 * Ticks per cron run: a run starts every minute, so prices stay under ~30 s old (the program
 * rejects prices older than 120 s). A tick makes ~15 subrequests and the Workers Free plan
 * allows 50 per invocation, so more ticks per run fail with "Too many subrequests".
 */
const TICKS_PER_RUN = 2;
const ROLL_HOURS = 4;
const ROLL_LIQUIDITY = 2_000n * USD;
const FAUCET_USDC = 1_000n * USD;
const FAUCET_SOL = 50_000_000n; // 0.05 SOL, for fees and account rent
const SOL_TOP_UP_BELOW = 20_000_000n;
/** The keeper keeps this much SOL for its own fees. */
const KEEPER_SOL_RESERVE = 500_000_000n;
const DAY = 86_400;
const MAX_CLAIMS_PER_IP = 10;

const ALLOWED_ORIGINS = ['https://necxsoft.com', 'https://www.necxsoft.com', 'http://127.0.0.1:5173', 'http://localhost:5173'];

async function keeperClient(env: Env) {
  const keypair = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(env.KEEPER_SECRET_KEY)));
  return createClient()
    .use(signer(keypair))
    .use(solanaRpc({ rpcUrl: env.RPC_URL, transactionConfig: { version: 1 } }));
}

async function runKeeper(env: Env) {
  const client = await keeperClient(env);
  const keeper = createKeeper(client, { rollHours: ROLL_HOURS, rollLiquidity: ROLL_LIQUIDITY, mintLiquidity: false });
  for (let i = 0; i < TICKS_PER_RUN; i++) {
    const started = Date.now();
    try {
      // Prediction markets only need minute resolution, so only the last tick handles them.
      await keeper.tick({ predictions: i === TICKS_PER_RUN - 1 });
    } catch (e) {
      console.error('tick failed:', (e as Error).message);
    }
    if (i < TICKS_PER_RUN - 1) await new Promise((r) => setTimeout(r, Math.max(0, TICK_MS - (Date.now() - started))));
  }
}

function json(body: unknown, status: number, origin: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'origin';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function faucet(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
      },
    });
  }
  if (request.method !== 'POST') return json({ error: 'Use POST' }, 405, origin);

  const { wallet } = ((await request.json().catch(() => ({}))) ?? {}) as { wallet?: string };
  if (!wallet || !isAddress(wallet)) return json({ error: 'Invalid wallet address' }, 400, origin);
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const walletKey = `wallet:${wallet}`;
  const ipKey = `ip:${ip}`;
  if (await env.FAUCET.get(walletKey)) return json({ error: 'This wallet already claimed test funds in the last 24 hours.' }, 429, origin);
  const ipClaims = Number((await env.FAUCET.get(ipKey)) ?? 0);
  if (ipClaims >= MAX_CLAIMS_PER_IP) return json({ error: 'Too many claims from your network today. Try again tomorrow.' }, 429, origin);

  const client = await keeperClient(env);
  const state = await loadPerpsState(client.rpc);
  if (!state) return json({ error: 'Exchange not found' }, 503, origin);
  const mint = state.exchange.collateralMint;
  const owner = wallet as Address;
  const [faucetUsdc, keeperSol, walletSol] = await Promise.all([
    tokenBalance(client.rpc, client.payer.address, mint),
    client.rpc.getBalance(client.payer.address).send().then((r) => r.value),
    client.rpc.getBalance(owner).send().then((r) => r.value),
  ]);
  if (faucetUsdc < FAUCET_USDC) return json({ error: 'The faucet is empty. Please tell the Necxsoft team.' }, 503, origin);
  const sendSol = walletSol < SOL_TOP_UP_BELOW && keeperSol > KEEPER_SOL_RESERVE + FAUCET_SOL;

  const result = await client.sendTransaction([
    await createAtaIx(client.payer, owner, mint),
    getTransferInstruction({
      source: await ata(client.payer.address, mint),
      destination: await ata(owner, mint),
      authority: client.payer,
      amount: FAUCET_USDC,
    }),
    ...(sendSol ? [getTransferSolInstruction({ source: client.payer, destination: owner, amount: lamports(FAUCET_SOL) })] : []),
  ]);

  await Promise.all([
    env.FAUCET.put(walletKey, '1', { expirationTtl: DAY }),
    env.FAUCET.put(ipKey, String(ipClaims + 1), { expirationTtl: DAY }),
  ]);
  return json(
    {
      usdc: formatUsd(FAUCET_USDC, 0),
      sol: sendSol ? Number(FAUCET_SOL) / 1e9 : 0,
      signature: result.context.signature,
    },
    200,
    origin,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/perps-and-predictions/api/faucet') {
      try {
        return await faucet(request, env);
      } catch (e) {
        console.error('faucet failed:', (e as Error).message);
        return json({ error: 'Faucet transaction failed. Try again in a minute.' }, 500, request.headers.get('origin'));
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runKeeper(env));
  },
};
