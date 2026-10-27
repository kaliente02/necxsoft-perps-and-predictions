# Necxsoft Perps — perpetual futures on Solana

A pool-based perpetuals exchange (GMX / Jupiter-Perps style). Traders open leveraged long or short
positions against a shared USDC liquidity pool. LPs deposit USDC, receive NLP (Necxsoft Liquidity Pool) tokens, earn trading and borrow
fees, and take the other side of trader PnL.

```
programs/my_defi_dapp/   Anchor program (Rust) + LiteSVM tests
app/                     React + Vite web app, Codama-generated Kit client, admin/keeper scripts
```

## How it works

| Concept | Implementation |
|---|---|
| Collateral | Any 6-decimal SPL mint (a mock USDC on local/devnet), held in one vault PDA |
| Accounting | `vault = pool_balance (LPs) + total_collateral (traders)`, checked in every test |
| Positions | One PDA per (market, owner, side); increases merge at a size-weighted entry price |
| PnL | `base = size / entry_price`; long PnL = `base × price − size`, short is the inverse |
| Fees | Open/close fee on size; hourly borrow fee via a cumulative per-market index |
| LP pricing | AUM = pool balance − traders' aggregate unrealized PnL (every market passed as remaining accounts) |
| Risk | Max leverage, maintenance margin, per-side OI caps, pool utilization cap, stale-price check, slippage limit |
| Liquidation | Permissionless once equity < maintenance margin; liquidator earns a fee, owner gets any remainder |
| Editing | Add collateral (`increase_position` with zero size), withdraw collateral or close part of a position (`decrease_position`: realized profit is paid out, losses stay with the position) |
| Orders | Jupiter-style resting `Order` PDAs: limit (escrows collateral), take-profit and stop-loss (all or part of a position). A keeper fills them at the oracle price once `trigger_price` is crossed and keeps the order's rent |
| History | The app rebuilds trade history and PnL cards from the program's events in the owner's transaction logs |
| Order book | The Trade page shows every trader's resting limit orders as bids and asks, grouped by price around the oracle mark, plus a feed of recent fills decoded from market events. Market orders fill against the pool, so they never rest in the book |
| Oracle | Per-market price pushed by an oracle authority (the keeper) |

Instructions: `initialize`, `add_market`, `update_exchange`, `update_market`, `update_price`,
`add_liquidity`, `remove_liquidity`, `increase_position`, `decrease_position`, `close_position`, `liquidate`,
`place_order`, `cancel_order`, `execute_limit_order`, `execute_trigger_order`.

## Run it locally

Requires Anchor CLI 1.1.2, Solana CLI 3.1.x, Surfpool, Node 20.18+.

```bash
anchor build && cargo test              # build + LiteSVM tests

surfpool start --no-deploy              # terminal 1: local network on :8899
solana -u l airdrop 50
anchor deploy --provider.cluster localnet

cd app && npm install
npm run setup -- init                   # mock USDC, exchange, SOL/BTC/ETH markets
npm run setup -- seed                   # 100,000 mock USDC of pool liquidity (from the admin)
npm run setup -- faucet <YOUR_WALLET>   # 10,000 mock USDC
npm run keeper                          # terminal 2: push prices, liquidate, fill orders
npm run dev                             # terminal 3: http://localhost:5173
npm run smoke                           # optional end-to-end check
```

Point your wallet at the same network (localhost:8899). For devnet: deploy with
`anchor deploy --provider.cluster devnet`, run the scripts with `RPC_URL=https://api.devnet.solana.com`,
and copy `app/.env.example` to `app/.env` with the devnet values. Scripts send transaction v1 by default;
set `TX_VERSION=0` for a cluster without SIMD-0385. The web app falls back to v0 for wallets that can't sign v1.

After changing the program: `anchor build && (cd app && npm run codegen)`.

## Prediction markets (Predict tab)

Binary YES/NO markets in the same program, paid out in the same USDC. They run separately from the perps pool: each market has its own vault.

| | |
|---|---|
| **Pricing** | Constant-product AMM over outcome shares. Each USDC in mints a complete set (1 YES + 1 NO) and each USDC out burns one, so `vault == total_sets + fees` always holds. The YES price, `no_reserve / (yes_reserve + no_reserve)`, reads as the live probability. Buy or sell any time before close; the fee is set per market (default 1%). |
| **Price markets** | "Will SOL be at or above $X at T?" These settle from the perps oracle on the first price at or after close. `resolve_price_market` is permissionless, and the keeper calls it automatically. |
| **Custom markets** | Admin-created questions, resolved by the admin as Yes, No or Invalid. Invalid pays 50¢ per share. On a price market the admin can only choose Invalid, as an escape hatch. |
| **Payout** | `redeem_shares` pays $1 per winning share and closes the position. The creator calls `withdraw_prediction_liquidity` to recover the pool's shares and fees. |

Instructions: `create_prediction`, `buy_shares`, `sell_shares`, `resolve_price_market`, `resolve_prediction`, `redeem_shares`, `withdraw_prediction_liquidity`.

```bash
npm run setup -- predict-demo                                  # 24h price market per perp + sample questions
npm run setup -- predict-price SOL 200 24 [liquidity]          # SOL >= $200 in 24h
npm run setup -- predict-custom "Question?" 72 [yes%] [liq]
npm run setup -- predict-resolve <market> yes|no|invalid
```

The keeper also keeps one rolling price market per perp open (`ROLL_HOURS`, default 4; set it to 0 to disable). It resolves these at close and recycles their liquidity.

## Before mainnet (not production-ready)

- **Oracle:** prices are pushed by a single trusted key from Coinbase's public API. Replace with an on-chain
  pull oracle (e.g. Pyth) verified inside `increase_position` / `close_position` / `liquidate`, with confidence checks.
- **No partial close, collateral withdrawal, or funding between longs and shorts.** Borrow fees only.
- **Rounding** uses floor division throughout; review direction-of-rounding against the pool.
- **Admin** is a single key with pause and parameter control; use a multisig + timelock.
- Get an independent audit.
