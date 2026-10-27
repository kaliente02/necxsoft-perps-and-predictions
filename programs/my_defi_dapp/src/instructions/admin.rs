use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct AddMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ ErrorCode::Unauthorized,
    )]
    pub exchange: Account<'info, Exchange>,
    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, exchange.key().as_ref(), &[exchange.num_markets]],
        bump
    )]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

pub fn handle_add_market(
    ctx: Context<AddMarket>,
    symbol: String,
    oracle_authority: Pubkey,
    initial_price: u64,
    hourly_borrow_rate: u64,
    max_open_interest: u64,
) -> Result<()> {
    let bytes = symbol.as_bytes();
    require!(
        !bytes.is_empty() && bytes.len() <= MAX_SYMBOL_LEN,
        ErrorCode::InvalidSymbol
    );
    require!(initial_price > 0, ErrorCode::InvalidPrice);
    let exchange = &mut ctx.accounts.exchange;
    require!(exchange.num_markets < MAX_MARKETS, ErrorCode::TooManyMarkets);

    let mut symbol_bytes = [0u8; MAX_SYMBOL_LEN];
    symbol_bytes[..bytes.len()].copy_from_slice(bytes);
    let now = Clock::get()?.unix_timestamp;

    ctx.accounts.market.set_inner(Market {
        exchange: exchange.key(),
        index: exchange.num_markets,
        symbol: symbol_bytes,
        oracle_authority,
        price: initial_price,
        price_updated_at: now,
        hourly_borrow_rate,
        cumulative_borrow_index: 0,
        last_borrow_update: now,
        max_open_interest,
        long_open_interest: 0,
        long_base: 0,
        short_open_interest: 0,
        short_base: 0,
        bump: ctx.bumps.market,
    });
    exchange.num_markets += 1;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateExchange<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ ErrorCode::Unauthorized,
    )]
    pub exchange: Account<'info, Exchange>,
}

pub fn handle_update_exchange(
    ctx: Context<UpdateExchange>,
    params: RiskParams,
    paused: bool,
) -> Result<()> {
    params.validate()?;
    let exchange = &mut ctx.accounts.exchange;
    exchange.params = params;
    exchange.paused = paused;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ ErrorCode::Unauthorized,
    )]
    pub exchange: Account<'info, Exchange>,
    #[account(mut, has_one = exchange)]
    pub market: Account<'info, Market>,
}

pub fn handle_update_market(
    ctx: Context<UpdateMarket>,
    oracle_authority: Pubkey,
    hourly_borrow_rate: u64,
    max_open_interest: u64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    // Settle borrow fees at the old rate before changing it.
    market.accrue_borrow(Clock::get()?.unix_timestamp)?;
    market.oracle_authority = oracle_authority;
    market.hourly_borrow_rate = hourly_borrow_rate;
    market.max_open_interest = max_open_interest;
    Ok(())
}
