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
        max_hourly_funding_rate: 0,
        funding_rate: 0,
        cumulative_funding_index: 0,
        long_fee_index: 0,
        short_fee_index: 0,
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
    market.accrue_fees(Clock::get()?.unix_timestamp)?;
    market.oracle_authority = oracle_authority;
    market.hourly_borrow_rate = hourly_borrow_rate;
    market.max_open_interest = max_open_interest;
    Ok(())
}

#[derive(Accounts)]
pub struct ConfigureMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ ErrorCode::Unauthorized,
    )]
    pub exchange: Box<Account<'info, Exchange>>,
    /// CHECK: a market of this exchange. Markets created before funding have a shorter layout
    /// that `Account<Market>` can't read, so the handler migrates and validates it by hand.
    #[account(mut, owner = crate::ID)]
    pub market: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + std::mem::size_of::<MarketHistory>(),
        seeds = [HISTORY_SEED, market.key().as_ref()],
        bump
    )]
    pub history: AccountLoader<'info, MarketHistory>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + std::mem::size_of::<LiquidationFeed>(),
        seeds = [LIQUIDATION_FEED_SEED],
        bump
    )]
    pub liquidation_feed: AccountLoader<'info, LiquidationFeed>,
    pub system_program: Program<'info, System>,
}

/// Admin: set a market's full-skew funding rate. Also migrates a market created before funding
/// to the current layout (its fee indices start at its borrow index, so open positions carry on
/// unchanged) and creates the market's history and the exchange's liquidation feed if missing.
pub fn handle_configure_market(ctx: Context<ConfigureMarket>, max_hourly_funding_rate: u64) -> Result<()> {
    require!(
        max_hourly_funding_rate <= MAX_HOURLY_FUNDING_RATE,
        ErrorCode::InvalidRiskParams
    );
    let info = ctx.accounts.market.to_account_info();
    let space = 8 + Market::INIT_SPACE;
    let migrating = info.data_len() < space;
    if migrating {
        require!(
            info.try_borrow_data()?.starts_with(Market::DISCRIMINATOR),
            ErrorCode::InvalidMarketAccount
        );
        let rent = Rent::get()?.minimum_balance(space).saturating_sub(info.lamports());
        if rent > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.admin.to_account_info(),
                        to: info.clone(),
                    },
                ),
                rent,
            )?;
        }
        info.resize(space)?;
    }

    let mut market = Market::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    require_keys_eq!(market.exchange, ctx.accounts.exchange.key(), ErrorCode::InvalidMarketAccount);
    let now = Clock::get()?.unix_timestamp;
    market.accrue_fees(now)?;
    if migrating {
        // The resized tail is zeroed; start both sides where open positions' entries point.
        let index = market.cumulative_borrow_index as i128;
        market.long_fee_index = index;
        market.short_fee_index = index;
        market.cumulative_funding_index = 0;
    }
    market.max_hourly_funding_rate = max_hourly_funding_rate;
    market.update_funding_rate();
    market.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
    Ok(())
}
