import { type Address, type Rpc, type SolanaRpcApi, getAddressDecoder, getBase64Encoder } from '@solana/kit';
import { ata } from './perps';

// ---------- wallet USDC flows per product, from the owner's token-account history ----------
//
// Profit = USDC received - USDC paid + what's still open. Every payment in or out of the wallet's
// USDC account goes through that account, so its transaction history covers trades the keeper
// fills too (take-profits, stop-losses, liquidation payouts). Faucet mints carry no exchange
// event, so they never count as profit.

export type Product = 'perps' | 'predict' | 'earn';

export type Flow = {
  signature: string;
  time: number | null;
  product: Product;
  /** Change in the wallet's USDC, 6 decimals: positive when the wallet received USDC. */
  amount: bigint;
  /** Trading fees paid in this transaction. */
  fee: bigint;
  /** Perps closes (full or partial) with a price gain, and with a loss or liquidation. */
  wins: number;
  losses: number;
};

export type FlowHistory = { flows: Flow[]; complete: boolean };

const MAX_SIGNATURES = 1000;

// Anchor event discriminators, from target/idl/my_defi_dapp.json.
const EVENTS: Record<string, string> = {
  '73,58,247,181,100,237,249,81': 'PositionIncreased',
  '251,151,37,204,127,87,115,232': 'PositionDecreased',
  '157,163,227,228,13,97,138,121': 'PositionClosed',
  '40,107,90,214,96,30,61,128': 'PositionLiquidated',
  '96,130,204,234,169,219,216,227': 'OrderPlaced',
  '108,56,128,68,168,113,168,239': 'OrderCancelled',
  '74,135,231,5,168,106,194,117': 'OrderExecuted',
  '222,217,188,250,98,184,148,163': 'SharesTraded',
  '126,25,197,178,229,159,6,188': 'PredictionRedeemed',
  '132,132,193,214,12,99,40,28': 'LiquidityChanged',
};

const PRODUCT: Record<string, Product> = {
  SharesTraded: 'predict',
  PredictionRedeemed: 'predict',
  LiquidityChanged: 'earn',
};

/** Byte offset of the owner field: prediction events start with the market. */
const OWNER_OFFSET: Record<string, number> = { SharesTraded: 40, PredictionRedeemed: 40 };

const addressDecoder = getAddressDecoder();
const u64 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getBigUint64(at, true);
const i64 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getBigInt64(at, true);

/** `closed`: realized price PnL of a closing trade, null for anything else. */
type Decoded = { product: Product; fee: bigint; closed: bigint | null };

function decode(bytes: Uint8Array, owner: Address): Decoded | null {
  const name = EVENTS[Array.from(bytes.subarray(0, 8)).join(',')];
  if (!name) return null;
  const at = OWNER_OFFSET[name] ?? 8;
  if (addressDecoder.decode(bytes.subarray(at, at + 32)) !== owner) return null;
  const product = PRODUCT[name] ?? 'perps';
  // Field offsets past owner(32) + market(32) + side(1) + price(8) + size(8).
  switch (name) {
    case 'PositionIncreased':
      return { product, fee: u64(bytes, 97), closed: null };
    case 'PositionDecreased': {
      const fee = u64(bytes, 97);
      const size = u64(bytes, 81);
      // A decrease with no size change is a collateral withdrawal, not a trade.
      return { product, fee, closed: size > 0n ? i64(bytes, 89) : null };
    }
    case 'PositionClosed':
      return { product, fee: 0n, closed: i64(bytes, 89) };
    case 'PositionLiquidated':
      return { product, fee: 0n, closed: -1n };
    case 'SharesTraded':
      // market, owner, outcome(1), buy(1), shares(8), amount(8), fee(8)
      return { product, fee: u64(bytes, 90), closed: null };
    default:
      return { product, fee: 0n, closed: null };
  }
}

const flowCache = new Map<string, Flow | null>();

/** The owner's exchange cash flows, newest first. Transactions are cached, so polling only fetches new ones. */
export async function loadFlows(rpc: Rpc<SolanaRpcApi>, owner: Address, mint: Address): Promise<FlowHistory> {
  const account = await ata(owner, mint);
  const signatures = await rpc.getSignaturesForAddress(account, { limit: MAX_SIGNATURES, commitment: 'confirmed' }).send();
  const ok = signatures.filter((s) => s.err === null);
  const missing = ok.filter((s) => !flowCache.has(s.signature));
  // Small batches keep public RPC endpoints from rate-limiting us.
  for (let i = 0; i < missing.length; i += 5) {
    await Promise.all(
      missing.slice(i, i + 5).map(async (s) => {
        const tx = await rpc
          .getTransaction(s.signature, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'confirmed' })
          .send();
        if (!tx) return;
        let product: Product | null = null;
        let fee = 0n;
        let wins = 0;
        let losses = 0;
        for (const line of tx.meta?.logMessages ?? []) {
          if (!line.startsWith('Program data: ')) continue;
          const event = decode(getBase64Encoder().encode(line.slice(14)) as Uint8Array, owner);
          if (!event) continue;
          product ??= event.product;
          fee += event.fee;
          if (event.closed !== null) {
            if (event.closed > 0n) wins++;
            else losses++;
          }
        }
        const balance = (list: readonly { mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null | undefined) =>
          (list ?? []).filter((b) => b.mint === mint && b.owner === owner).reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
        const amount = balance(tx.meta?.postTokenBalances) - balance(tx.meta?.preTokenBalances);
        flowCache.set(
          s.signature,
          product && { signature: s.signature, time: s.blockTime == null ? null : Number(s.blockTime), product, amount, fee, wins, losses },
        );
      }),
    );
  }
  return {
    flows: ok.flatMap((s) => flowCache.get(s.signature) ?? []),
    complete: signatures.length < MAX_SIGNATURES,
  };
}

export type ProductSummary = {
  /** USDC paid into the exchange. */
  paidIn: bigint;
  /** USDC received back. */
  received: bigint;
  /** Current value of what's still open. */
  open: bigint;
  /** received - paidIn + open */
  net: bigint;
  fees: bigint;
};

export function summarize(flows: Flow[], product: Product, open: bigint): ProductSummary {
  let paidIn = 0n;
  let received = 0n;
  let fees = 0n;
  for (const f of flows) {
    if (f.product !== product) continue;
    if (f.amount < 0n) paidIn -= f.amount;
    else received += f.amount;
    fees += f.fee;
  }
  return { paidIn, received, open, net: received - paidIn + open, fees };
}
