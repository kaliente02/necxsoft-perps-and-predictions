use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use super::{transfer_from_vault, transfer_to_vault};
use crate::{constants::*, error::ErrorCode, state::*};

fn check_price_limit(side: Side, increase: bool, price: u64, price_limit: u64) -> Result<()> {
    // Buying (long open / short close) must not execute above the limit; selling not below it.
    let buying = (side == Side::Long) == increase;
    let ok = if buying {
        price <= price_limit
    } else {
        price >= price_limit
    };
    require!(ok, ErrorCode::SlippageExceeded);
    Ok(())
}

#[derive(Accounts)]
#[instruction(side: Side)]
pub struct IncreasePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, has_one = exchange)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref(), &[side as u8]],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = exchange.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = exchange.collateral_mint,
        token::authority = owner,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Open a position or add size and/or collateral to an existing one.
pub fn handle_increase_position(
    ctx: Context<IncreasePosition>,
    side: Side,
    collateral_amount: u64,
    size_delta_usd: u64,
    price_limit: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &mut *ctx.accounts;
    let exchange = &mut accounts.exchange;
    let market = &mut accounts.market;
    let position = &mut accounts.position;
    require!(!exchange.paused, ErrorCode::Paused);

    market.accrue_borrow(now)?;
    let price = market.fresh_price(now, exchange.params.max_price_age_secs)?;
    if position.size_usd == 0 {
        init_position(position, accounts.owner.key(), market, side, now, ctx.bumps.position);
    }
    if size_delta_usd > 0 {
        check_price_limit(side, true, price, price_limit)?;
    }

    let fees = apply_increase(exchange, market, position, collateral_amount, size_delta_usd, price, now)?;
    transfer_to_vault(
        &accounts.token_program,
        &accounts.user_collateral,
        &accounts.vault,
        &accounts.owner,
        collateral_amount,
    )?;

    emit!(PositionIncreased {
        owner: accounts.owner.key(),
        market: market.key(),
        side,
        price,
        size_delta: size_delta_usd,
        collateral_delta: collateral_amount,
        fee: fees,
    });
    Ok(())
}

pub(crate) fn init_position(
    position: &mut Account<Position>,
    owner: Pubkey,
    market: &Account<Market>,
    side: Side,
    now: i64,
    bump: u8,
) {
    position.set_inner(Position {
        owner,
        market: market.key(),
        side,
        size_usd: 0,
        collateral: 0,
        base: 0,
        entry_price: 0,
        entry_borrow_index: market.cumulative_borrow_index,
        opened_at: now,
        last_updated: now,
        bump,
    });
}

/// Add `collateral_in` (already in, or about to enter, the vault) and `size_delta_usd` to a
/// position, settling borrow fees and charging the open fee. Returns the fees charged.
pub(crate) fn apply_increase(
    exchange: &mut Exchange,
    market: &mut Market,
    position: &mut Position,
    collateral_in: u64,
    size_delta_usd: u64,
    price: u64,
    now: i64,
) -> Result<u64> {
    let params = exchange.params;
    if position.size_usd == 0 {
        require!(size_delta_usd > 0, ErrorCode::ZeroAmount);
    } else {
        require!(
            size_delta_usd > 0 || collateral_in > 0,
            ErrorCode::ZeroAmount
        );
    }

    // Settle borrow fees accrued so far, then charge the opening fee on the added size.
    let borrow_fee = position.borrow_fee(market);
    let trade_fee = bps_of(size_delta_usd, params.trade_fee_bps);
    let fees = borrow_fee
        .checked_add(trade_fee)
        .ok_or(ErrorCode::MathOverflow)?;
    let collateral = position
        .collateral
        .checked_add(collateral_in)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_sub(fees)
        .ok_or(ErrorCode::InsufficientMargin)?;
    require!(
        collateral >= params.min_collateral,
        ErrorCode::CollateralTooSmall
    );

    let base_delta = mul_div(size_delta_usd as u128, BASE_SCALE, price as u128);
    position.collateral = collateral;
    position.size_usd = position
        .size_usd
        .checked_add(size_delta_usd)
        .ok_or(ErrorCode::MathOverflow)?;
    position.base = position
        .base
        .checked_add(base_delta)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(position.base > 0, ErrorCode::ZeroAmount);
    position.entry_price = mul_div(position.size_usd as u128, BASE_SCALE, position.base) as u64;
    position.entry_borrow_index = market.cumulative_borrow_index;
    position.last_updated = now;
    check_position_risk(position, market, price, &params)?;

    market.add_open_interest(position.side, size_delta_usd, base_delta)?;
    exchange.total_open_interest = exchange
        .total_open_interest
        .checked_add(size_delta_usd)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        exchange.total_open_interest <= exchange.max_open_interest(),
        ErrorCode::PoolUtilizationCap
    );
    exchange.pool_balance = exchange
        .pool_balance
        .checked_add(fees)
        .ok_or(ErrorCode::MathOverflow)?;
    // Fees move from trader collateral to the pool.
    exchange.total_collateral = exchange
        .total_collateral
        .checked_add(collateral_in)
        .and_then(|c| c.checked_sub(fees))
        .ok_or(ErrorCode::MathOverflow)?;
    Ok(fees)
}

fn check_position_risk(position: &Position, market: &Market, price: u64, params: &RiskParams) -> Result<()> {
    require!(
        (position.size_usd as u128) <= (position.collateral as u128) * params.max_leverage as u128,
        ErrorCode::LeverageTooHigh
    );
    let valuation = position.value(market, price, params);
    require!(
        valuation.equity > position.maintenance_margin(params) as i128,
        ErrorCode::InsufficientMargin
    );
    Ok(())
}

#[derive(Accounts)]
pub struct DecreasePosition<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, has_one = exchange)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut,
        has_one = owner,
        has_one = market,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref(), &[position.side as u8]],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = exchange.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = exchange.collateral_mint,
        token::authority = owner,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Partially close a position and/or withdraw collateral from it. Realized profit is paid
/// out on top of `collateral_out`; realized losses and fees come out of the remaining collateral.
pub fn handle_decrease_position(
    ctx: Context<DecreasePosition>,
    size_delta_usd: u64,
    collateral_out: u64,
    price_limit: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &mut *ctx.accounts;
    let exchange = &mut accounts.exchange;
    let market = &mut accounts.market;
    let position = &mut accounts.position;

    market.accrue_borrow(now)?;
    let price = market.fresh_price(now, exchange.params.max_price_age_secs)?;
    if size_delta_usd > 0 {
        check_price_limit(position.side, false, price, price_limit)?;
    }

    let decrease = apply_decrease(exchange, market, position, size_delta_usd, collateral_out, price, now)?;
    transfer_from_vault(
        &accounts.token_program,
        &accounts.vault,
        &accounts.user_collateral,
        exchange,
        decrease.payout,
    )?;

    emit!(PositionDecreased {
        owner: position.owner,
        market: market.key(),
        side: position.side,
        price,
        size_delta: size_delta_usd,
        pnl: decrease.pnl as i64,
        fee: decrease.fees,
        payout: decrease.payout,
    });
    Ok(())
}

pub(crate) struct Decrease {
    pub pnl: i128,
    pub fees: u64,
    pub payout: u64,
}

/// Remove `size_delta_usd` of size (strictly less than the whole position) and `collateral_out`
/// of collateral, settling borrow fees and the close fee on the removed size.
pub(crate) fn apply_decrease(
    exchange: &mut Exchange,
    market: &mut Market,
    position: &mut Position,
    size_delta_usd: u64,
    collateral_out: u64,
    price: u64,
    now: i64,
) -> Result<Decrease> {
    let params = exchange.params;
    require!(
        size_delta_usd > 0 || collateral_out > 0,
        ErrorCode::ZeroAmount
    );
    require!(
        size_delta_usd < position.size_usd,
        ErrorCode::UseClosePosition
    );

    let fees = position
        .borrow_fee(market)
        .checked_add(bps_of(size_delta_usd, params.trade_fee_bps))
        .ok_or(ErrorCode::MathOverflow)?;
    // The closed slice keeps the position's entry price, so it takes a proportional share of base.
    let base_delta = mul_div(position.base, size_delta_usd as u128, position.size_usd as u128);
    let value = mul_div(base_delta, price as u128, BASE_SCALE) as i128;
    let pnl = match position.side {
        Side::Long => value - size_delta_usd as i128,
        Side::Short => size_delta_usd as i128 - value,
    };
    let realized = pnl - fees as i128;

    let collateral = position.collateral as i128 - collateral_out as i128 + realized.min(0);
    require!(collateral >= 0, ErrorCode::InsufficientMargin);
    let collateral = collateral as u64;
    let payout = collateral_out
        .checked_add(realized.max(0) as u64)
        .ok_or(ErrorCode::MathOverflow)?;

    // The pool pays realized profit and receives fees and realized losses.
    let pool = exchange.pool_balance as i128 - realized;
    require!(pool >= 0, ErrorCode::InsufficientPoolLiquidity);
    exchange.pool_balance = pool as u64;
    exchange.total_collateral = exchange
        .total_collateral
        .checked_sub(position.collateral)
        .and_then(|c| c.checked_add(collateral))
        .ok_or(ErrorCode::MathOverflow)?;
    exchange.total_open_interest = exchange
        .total_open_interest
        .checked_sub(size_delta_usd)
        .ok_or(ErrorCode::MathOverflow)?;
    market.remove_open_interest(position.side, size_delta_usd, base_delta)?;

    position.collateral = collateral;
    position.size_usd -= size_delta_usd;
    position.base -= base_delta;
    position.entry_borrow_index = market.cumulative_borrow_index;
    position.last_updated = now;
    require!(
        collateral >= params.min_collateral,
        ErrorCode::CollateralTooSmall
    );
    check_position_risk(position, market, price, &params)?;

    Ok(Decrease { pnl, fees, payout })
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, has_one = exchange)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut,
        close = owner,
        has_one = owner,
        has_one = market,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref(), &[position.side as u8]],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = exchange.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = exchange.collateral_mint,
        token::authority = owner,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Close the whole position, realizing PnL and paying out remaining equity.
pub fn handle_close_position(ctx: Context<ClosePosition>, price_limit: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &mut *ctx.accounts;
    let exchange = &mut accounts.exchange;
    let market = &mut accounts.market;
    let position = &accounts.position;

    market.accrue_borrow(now)?;
    let price = market.fresh_price(now, exchange.params.max_price_age_secs)?;
    check_price_limit(position.side, false, price, price_limit)?;

    let (pnl, payout) = apply_close(exchange, market, position, price)?;
    transfer_from_vault(
        &accounts.token_program,
        &accounts.vault,
        &accounts.user_collateral,
        exchange,
        payout,
    )?;

    emit!(PositionClosed {
        owner: position.owner,
        market: market.key(),
        side: position.side,
        price,
        size_usd: position.size_usd,
        pnl: pnl as i64,
        payout,
        collateral: position.collateral,
    });
    Ok(())
}

/// Settle a full close at `price`. Returns (price PnL, payout to the owner).
pub(crate) fn apply_close(
    exchange: &mut Exchange,
    market: &mut Market,
    position: &Position,
    price: u64,
) -> Result<(i128, u64)> {
    let valuation = position.value(market, price, &exchange.params);
    let payout = valuation.equity.max(0) as u64;
    settle_closed_position(exchange, market, position, payout)?;
    Ok((valuation.pnl, payout))
}

/// Remove a position from open interest and move its collateral between trader and pool
/// balances so that exactly `paid_out` leaves the vault.
pub(crate) fn settle_closed_position(
    exchange: &mut Exchange,
    market: &mut Market,
    position: &Position,
    paid_out: u64,
) -> Result<()> {
    market.remove_open_interest(position.side, position.size_usd, position.base)?;
    exchange.total_open_interest = exchange
        .total_open_interest
        .checked_sub(position.size_usd)
        .ok_or(ErrorCode::MathOverflow)?;
    exchange.total_collateral = exchange
        .total_collateral
        .checked_sub(position.collateral)
        .ok_or(ErrorCode::MathOverflow)?;
    // Pool gains the trader's collateral and pays out `paid_out` (which can exceed collateral on profit).
    let pool = exchange.pool_balance as i128 + position.collateral as i128 - paid_out as i128;
    require!(pool >= 0, ErrorCode::InsufficientPoolLiquidity);
    exchange.pool_balance = pool as u64;
    Ok(())
}
