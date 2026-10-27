use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct RiskParams {
    /// Maximum position size / collateral, as a whole multiple (e.g. 50 = 50x).
    pub max_leverage: u16,
    /// Fee charged on position size when opening and when closing.
    pub trade_fee_bps: u16,
    /// Positions whose equity falls below size * maintenance_margin_bps are liquidatable.
    pub maintenance_margin_bps: u16,
    /// Share of position size paid to the liquidator (capped by remaining equity).
    pub liquidation_fee_bps: u16,
    /// Total open interest may not exceed pool_balance * max_utilization_bps.
    pub max_utilization_bps: u16,
    /// Oracle prices older than this are rejected.
    pub max_price_age_secs: u32,
    /// Minimum collateral a position must hold, in collateral base units.
    pub min_collateral: u64,
}

impl RiskParams {
    pub fn validate(&self) -> Result<()> {
        let bps = BPS_DENOMINATOR as u32;
        require!(
            self.max_leverage >= 1 && self.max_leverage <= MAX_LEVERAGE_CAP,
            ErrorCode::InvalidRiskParams
        );
        require!(self.trade_fee_bps <= 100, ErrorCode::InvalidRiskParams);
        // A freshly opened max-leverage position must not be instantly liquidatable.
        require!(
            self.maintenance_margin_bps > 0
                && (self.maintenance_margin_bps as u32 + self.trade_fee_bps as u32)
                    * (self.max_leverage as u32)
                    < bps,
            ErrorCode::InvalidRiskParams
        );
        require!(
            self.liquidation_fee_bps <= self.maintenance_margin_bps,
            ErrorCode::InvalidRiskParams
        );
        require!(
            self.max_utilization_bps > 0 && self.max_utilization_bps as u32 <= bps,
            ErrorCode::InvalidRiskParams
        );
        require!(self.max_price_age_secs > 0, ErrorCode::InvalidRiskParams);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Exchange {
    pub admin: Pubkey,
    pub collateral_mint: Pubkey,
    pub vault: Pubkey,
    pub lp_mint: Pubkey,
    /// Vault assets owned by liquidity providers (deposits + fees + trader losses - trader profits).
    pub pool_balance: u64,
    /// Vault assets owned by traders as position collateral.
    pub total_collateral: u64,
    /// Sum of open position sizes (USD) across all markets and sides.
    pub total_open_interest: u64,
    pub num_markets: u8,
    pub paused: bool,
    pub params: RiskParams,
    pub bump: u8,
    pub vault_bump: u8,
    pub lp_mint_bump: u8,
}

impl Exchange {
    pub fn max_open_interest(&self) -> u64 {
        mul_div(
            self.pool_balance as u128,
            self.params.max_utilization_bps as u128,
            BPS_DENOMINATOR as u128,
        ) as u64
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Side {
    Long,
    Short,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub exchange: Pubkey,
    pub index: u8,
    pub symbol: [u8; MAX_SYMBOL_LEN],
    pub oracle_authority: Pubkey,
    /// Mark price in USD with 6 decimals.
    pub price: u64,
    pub price_updated_at: i64,
    /// Borrow fee per hour per 1 USD of position size, scaled by BORROW_RATE_SCALE.
    pub hourly_borrow_rate: u64,
    pub cumulative_borrow_index: u128,
    pub last_borrow_update: i64,
    /// Per-side open interest cap in USD.
    pub max_open_interest: u64,
    pub long_open_interest: u64,
    pub long_base: u128,
    pub short_open_interest: u64,
    pub short_base: u128,
    pub bump: u8,
}

impl Market {
    pub fn accrue_borrow(&mut self, now: i64) -> Result<()> {
        let elapsed = now.saturating_sub(self.last_borrow_update);
        if elapsed > 0 {
            let delta = (self.hourly_borrow_rate as u128)
                .checked_mul(elapsed as u128)
                .ok_or(ErrorCode::MathOverflow)?
                / SECONDS_PER_HOUR as u128;
            self.cumulative_borrow_index = self
                .cumulative_borrow_index
                .checked_add(delta)
                .ok_or(ErrorCode::MathOverflow)?;
            self.last_borrow_update = now;
        }
        Ok(())
    }

    pub fn fresh_price(&self, now: i64, max_age_secs: u32) -> Result<u64> {
        require!(
            now.saturating_sub(self.price_updated_at) <= max_age_secs as i64,
            ErrorCode::StalePrice
        );
        Ok(self.price)
    }

    /// Aggregate unrealized PnL of all traders in this market at `price` (positive = traders winning).
    pub fn unrealized_trader_pnl(&self, price: u64) -> i128 {
        let long_value = mul_div(self.long_base, price as u128, BASE_SCALE) as i128;
        let short_value = mul_div(self.short_base, price as u128, BASE_SCALE) as i128;
        (long_value - self.long_open_interest as i128)
            + (self.short_open_interest as i128 - short_value)
    }

    pub fn add_open_interest(&mut self, side: Side, size_usd: u64, base: u128) -> Result<()> {
        let (oi, total_base) = match side {
            Side::Long => (&mut self.long_open_interest, &mut self.long_base),
            Side::Short => (&mut self.short_open_interest, &mut self.short_base),
        };
        *oi = oi.checked_add(size_usd).ok_or(ErrorCode::MathOverflow)?;
        *total_base = total_base.checked_add(base).ok_or(ErrorCode::MathOverflow)?;
        require!(*oi <= self.max_open_interest, ErrorCode::MarketOpenInterestCap);
        Ok(())
    }

    pub fn remove_open_interest(&mut self, side: Side, size_usd: u64, base: u128) -> Result<()> {
        let (oi, total_base) = match side {
            Side::Long => (&mut self.long_open_interest, &mut self.long_base),
            Side::Short => (&mut self.short_open_interest, &mut self.short_base),
        };
        *oi = oi.checked_sub(size_usd).ok_or(ErrorCode::MathOverflow)?;
        *total_base = total_base.checked_sub(base).ok_or(ErrorCode::MathOverflow)?;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: Side,
    /// Notional size in USD (6 decimals).
    pub size_usd: u64,
    /// Collateral in collateral-token base units (== USD, 6 decimals).
    pub collateral: u64,
    /// size_usd / entry price, scaled by BASE_SCALE.
    pub base: u128,
    /// Size-weighted average entry price.
    pub entry_price: u64,
    pub entry_borrow_index: u128,
    pub opened_at: i64,
    pub last_updated: i64,
    pub bump: u8,
}

/// Result of marking a position to market.
pub struct Valuation {
    pub pnl: i128,
    pub borrow_fee: u64,
    pub close_fee: u64,
    /// collateral + pnl - borrow_fee - close_fee
    pub equity: i128,
}

impl Position {
    pub fn pnl(&self, price: u64) -> i128 {
        let value = mul_div(self.base, price as u128, BASE_SCALE) as i128;
        match self.side {
            Side::Long => value - self.size_usd as i128,
            Side::Short => self.size_usd as i128 - value,
        }
    }

    pub fn borrow_fee(&self, market: &Market) -> u64 {
        let delta = market
            .cumulative_borrow_index
            .saturating_sub(self.entry_borrow_index);
        mul_div(self.size_usd as u128, delta, BORROW_RATE_SCALE) as u64
    }

    pub fn value(&self, market: &Market, price: u64, params: &RiskParams) -> Valuation {
        let pnl = self.pnl(price);
        let borrow_fee = self.borrow_fee(market);
        let close_fee = bps_of(self.size_usd, params.trade_fee_bps);
        let equity = self.collateral as i128 + pnl - borrow_fee as i128 - close_fee as i128;
        Valuation {
            pnl,
            borrow_fee,
            close_fee,
            equity,
        }
    }

    pub fn maintenance_margin(&self, params: &RiskParams) -> u64 {
        bps_of(self.size_usd, params.maintenance_margin_bps)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum OrderKind {
    /// Opens (or adds to) a position once the price reaches the trigger.
    Limit,
    /// Closes some or all of a position once the price moves in its favour.
    TakeProfit,
    /// Closes some or all of a position once the price moves against it.
    StopLoss,
}

/// A resting order filled by a keeper once the oracle price crosses `trigger_price`.
#[account]
#[derive(InitSpace)]
pub struct Order {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: Side,
    pub kind: OrderKind,
    pub trigger_price: u64,
    /// true: fills when price >= trigger_price; false: when price <= trigger_price.
    pub trigger_above: bool,
    /// Limit: size to open. Take-profit / stop-loss: size to close, 0 = the entire position.
    pub size_usd: u64,
    /// Limit only: collateral escrowed in the vault until the order fills or is cancelled.
    pub collateral: u64,
    /// Client-chosen id, part of the PDA seeds so an owner can hold many orders.
    pub id: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl Order {
    /// A long limit buys the dip, a long take-profit sells into strength and a long stop-loss
    /// sells into weakness; shorts mirror each of these.
    pub fn trigger_above(kind: OrderKind, side: Side) -> bool {
        match (kind, side) {
            (OrderKind::Limit, Side::Long) => false,
            (OrderKind::Limit, Side::Short) => true,
            (OrderKind::TakeProfit, Side::Long) => true,
            (OrderKind::TakeProfit, Side::Short) => false,
            (OrderKind::StopLoss, Side::Long) => false,
            (OrderKind::StopLoss, Side::Short) => true,
        }
    }

    pub fn triggered(&self, price: u64) -> bool {
        if self.trigger_above {
            price >= self.trigger_price
        } else {
            price <= self.trigger_price
        }
    }
}

pub fn mul_div(a: u128, b: u128, denominator: u128) -> u128 {
    // Inputs are bounded (u64 amounts, 1e9 scales) so a*b fits in u128.
    a.saturating_mul(b) / denominator
}

pub fn bps_of(amount: u64, bps: u16) -> u64 {
    mul_div(amount as u128, bps as u128, BPS_DENOMINATOR as u128) as u64
}

#[event]
pub struct PositionIncreased {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: Side,
    pub price: u64,
    pub size_delta: u64,
    pub collateral_delta: u64,
    pub fee: u64,
}

#[event]
pub struct PositionClosed {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: Side,
    pub price: u64,
    pub size_usd: u64,
    pub pnl: i64,
    pub payout: u64,
    /// Collateral held just before the close (appended last so older events still decode).
    pub collateral: u64,
}

#[event]
pub struct PositionDecreased {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: Side,
    pub price: u64,
    pub size_delta: u64,
    /// Price PnL realized on the closed portion (0 for a collateral withdrawal).
    pub pnl: i64,
    pub fee: u64,
    pub payout: u64,
}

#[event]
pub struct OrderPlaced {
    pub owner: Pubkey,
    pub order: Pubkey,
    pub market: Pubkey,
    pub side: Side,
    pub kind: OrderKind,
    pub trigger_price: u64,
    pub size_usd: u64,
    pub collateral: u64,
}

#[event]
pub struct OrderCancelled {
    pub owner: Pubkey,
    pub order: Pubkey,
}

#[event]
pub struct OrderExecuted {
    pub owner: Pubkey,
    pub order: Pubkey,
    pub executor: Pubkey,
    pub kind: OrderKind,
    pub price: u64,
}

#[event]
pub struct PositionLiquidated {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub liquidator: Pubkey,
    pub side: Side,
    pub price: u64,
    pub size_usd: u64,
    pub liquidator_reward: u64,
}

#[event]
pub struct LiquidityChanged {
    pub owner: Pubkey,
    pub collateral_amount: u64,
    pub lp_amount: u64,
    pub deposit: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Outcome {
    Yes,
    No,
    /// Custom markets only: every YES and NO share redeems for half a dollar.
    Invalid,
}

/// A binary YES/NO market priced by a constant-product AMM over outcome shares.
///
/// Every USDC that enters mints one complete set (1 YES + 1 NO share) and every USDC that leaves
/// burns one, so `total_sets` USDC always backs the shares. The YES probability is
/// `no_reserve / (yes_reserve + no_reserve)`. After resolution each winning share redeems 1 USDC.
/// The admin seeds the pool and, after resolution, withdraws what the pool's shares and fees are
/// worth. USDC sits in a per-market vault, separate from the perps pool.
#[account]
#[derive(InitSpace)]
pub struct PredictionMarket {
    pub exchange: Pubkey,
    pub creator: Pubkey,
    pub id: u64,
    #[max_len(MAX_QUESTION_LEN)]
    pub question: String,
    /// Price markets: the perps market whose oracle price settles it. Custom markets: default.
    pub oracle_market: Pubkey,
    /// Price markets resolve YES when the oracle price is at or above the strike.
    pub strike: u64,
    /// Trading stops at this time; price markets resolve on the first price at or after it.
    pub close_time: i64,
    pub yes_reserve: u64,
    pub no_reserve: u64,
    /// Shares the creator received when seeding at a probability other than 50%.
    pub creator_yes: u64,
    pub creator_no: u64,
    pub total_sets: u64,
    pub fee_bps: u16,
    /// Opening YES probability, for charts.
    pub initial_yes_bps: u16,
    pub fees: u64,
    pub volume: u64,
    pub resolved: bool,
    pub outcome: Outcome,
    pub resolved_price: u64,
    pub resolved_at: i64,
    pub created_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl PredictionMarket {
    pub fn is_price_market(&self) -> bool {
        self.oracle_market != Pubkey::default()
    }

    /// YES probability in basis points.
    pub fn yes_price_bps(&self) -> u64 {
        mul_div(
            self.no_reserve as u128,
            BPS_DENOMINATOR as u128,
            self.yes_reserve as u128 + self.no_reserve as u128,
        ) as u64
    }

    fn reserves(&self, outcome: Outcome) -> (u64, u64) {
        match outcome {
            Outcome::Yes => (self.yes_reserve, self.no_reserve),
            _ => (self.no_reserve, self.yes_reserve),
        }
    }

    fn set_reserves(&mut self, outcome: Outcome, this: u64, other: u64) {
        match outcome {
            Outcome::Yes => (self.yes_reserve, self.no_reserve) = (this, other),
            _ => (self.no_reserve, self.yes_reserve) = (this, other),
        }
    }

    /// Spend `amount` USDC (after fees) on `outcome` shares; returns the shares bought.
    pub fn buy(&mut self, outcome: Outcome, amount: u64) -> Result<u64> {
        let (this, other) = self.reserves(outcome);
        let k = this as u128 * other as u128;
        // Mint `amount` sets into the pool, then pay out `outcome` shares so that this*other >= k.
        let other_after = other.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
        let this_after = k.div_ceil(other_after as u128) as u64;
        let shares = (this as u128 + amount as u128 - this_after as u128) as u64;
        self.set_reserves(outcome, this_after, other_after);
        self.total_sets = self.total_sets.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
        Ok(shares)
    }

    /// Sell `shares` of `outcome` back to the pool; returns the USDC (before fees) they burn.
    pub fn sell(&mut self, outcome: Outcome, shares: u64) -> Result<u64> {
        let (this, other) = self.reserves(outcome);
        // Burn x complete sets after adding `shares` to the pool so that
        // (this + shares - x) * (other - x) = this * other, i.e. the smaller root of
        // x^2 - (this + shares + other) x + shares * other = 0.
        let b = this as u128 + shares as u128 + other as u128;
        let c = shares as u128 * other as u128;
        let disc = b.checked_mul(b).ok_or(ErrorCode::MathOverflow)? - 4 * c;
        let mut x = ((b - isqrt(disc)) / 2).min(other as u128 - 1) as u64;
        // isqrt rounds down, so x may overshoot by a unit; step back until the curve holds.
        let k = this as u128 * other as u128;
        while x > 0 && ((this + shares - x) as u128) * ((other - x) as u128) < k {
            x -= 1;
        }
        let this_after = this + shares - x;
        let other_after = other - x;
        self.set_reserves(outcome, this_after, other_after);
        self.total_sets -= x;
        Ok(x)
    }

    /// USDC a holder of `yes` and `no` shares receives after resolution.
    pub fn payout(&self, yes: u64, no: u64) -> u64 {
        match self.outcome {
            Outcome::Yes => yes,
            Outcome::No => no,
            Outcome::Invalid => ((yes as u128 + no as u128) / 2) as u64,
        }
    }
}

/// A trader's outcome shares in one prediction market.
#[account]
#[derive(InitSpace)]
pub struct PredictionPosition {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub yes_shares: u64,
    pub no_shares: u64,
    /// USDC spent minus USDC received from sales, for PnL display.
    pub net_cost: i64,
    pub bump: u8,
}

impl PredictionPosition {
    pub fn shares_mut(&mut self, outcome: Outcome) -> &mut u64 {
        match outcome {
            Outcome::Yes => &mut self.yes_shares,
            _ => &mut self.no_shares,
        }
    }
}

pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = 1u128 << ((128 - n.leading_zeros()).div_ceil(2));
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

#[event]
pub struct PredictionCreated {
    pub market: Pubkey,
    pub question: String,
    pub oracle_market: Pubkey,
    pub strike: u64,
    pub close_time: i64,
    pub liquidity: u64,
}

#[event]
pub struct SharesTraded {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub outcome: Outcome,
    pub buy: bool,
    pub shares: u64,
    /// USDC paid (buy) or received (sell), fees included.
    pub amount: u64,
    pub fee: u64,
    /// YES probability after the trade, in basis points.
    pub yes_price_bps: u64,
}

#[event]
pub struct PredictionResolved {
    pub market: Pubkey,
    pub outcome: Outcome,
    pub price: u64,
}

#[event]
pub struct PredictionRedeemed {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub payout: u64,
}
