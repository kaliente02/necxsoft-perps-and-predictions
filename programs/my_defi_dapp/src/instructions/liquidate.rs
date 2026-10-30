use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use super::{settle_closed_position, transfer_from_vault};
use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub liquidator: Signer<'info>,
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
    /// CHECK: receives the position's rent; validated by `has_one = owner` on the position.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = exchange.collateral_mint,
        token::authority = owner,
    )]
    pub owner_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = exchange.collateral_mint)]
    pub liquidator_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = exchange.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [LIQUIDATION_FEED_SEED], bump)]
    pub liquidation_feed: AccountLoader<'info, LiquidationFeed>,
    pub token_program: Program<'info, Token>,
}

/// Permissionlessly close a position whose equity is below maintenance margin.
pub fn handle_liquidate(ctx: Context<Liquidate>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &mut *ctx.accounts;
    let exchange = &mut accounts.exchange;
    let market = &mut accounts.market;
    let position = &accounts.position;
    let params = exchange.params;

    market.accrue_fees(now)?;
    let price = market.fresh_price(now, params.max_price_age_secs)?;

    let valuation = position.value(market, price, &params);
    require!(
        valuation.equity < position.maintenance_margin(&params) as i128,
        ErrorCode::NotLiquidatable
    );

    let remaining = valuation.equity.max(0) as u64;
    let reward = remaining.min(bps_of(position.size_usd, params.liquidation_fee_bps));
    let to_owner = remaining - reward;
    settle_closed_position(exchange, market, position, remaining)?;

    transfer_from_vault(
        &accounts.token_program,
        &accounts.vault,
        &accounts.liquidator_collateral,
        exchange,
        reward,
    )?;
    transfer_from_vault(
        &accounts.token_program,
        &accounts.vault,
        &accounts.owner_collateral,
        exchange,
        to_owner,
    )?;

    accounts.liquidation_feed.load_mut()?.push(LiquidationRecord {
        owner: position.owner,
        market: market.key(),
        time: now,
        price,
        size_usd: position.size_usd,
        collateral: position.collateral,
        liquidator_reward: reward,
        side: position.side as u8,
        _padding: [0; 7],
    });

    emit!(PositionLiquidated {
        owner: position.owner,
        market: market.key(),
        liquidator: accounts.liquidator.key(),
        side: position.side,
        price,
        size_usd: position.size_usd,
        liquidator_reward: reward,
    });
    Ok(())
}
