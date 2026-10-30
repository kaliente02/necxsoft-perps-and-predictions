use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    pub oracle_authority: Signer<'info>,
    #[account(mut, has_one = oracle_authority @ ErrorCode::InvalidOracleAuthority)]
    pub market: Account<'info, Market>,
    /// The market's hourly history; when passed, the first price each hour is recorded.
    #[account(mut, seeds = [HISTORY_SEED, market.key().as_ref()], bump)]
    pub history: Option<AccountLoader<'info, MarketHistory>>,
}

pub fn handle_update_price(ctx: Context<UpdatePrice>, price: u64) -> Result<()> {
    require!(price > 0, ErrorCode::InvalidPrice);
    let market = &mut ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;
    market.accrue_fees(now)?;
    market.price = price;
    market.price_updated_at = now;
    if let Some(history) = &ctx.accounts.history {
        history.load_mut()?.record(market, now);
    }
    Ok(())
}
