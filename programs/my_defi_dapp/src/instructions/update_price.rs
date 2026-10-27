use anchor_lang::prelude::*;

use crate::{error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    pub oracle_authority: Signer<'info>,
    #[account(mut, has_one = oracle_authority @ ErrorCode::InvalidOracleAuthority)]
    pub market: Account<'info, Market>,
}

pub fn handle_update_price(ctx: Context<UpdatePrice>, price: u64) -> Result<()> {
    require!(price > 0, ErrorCode::InvalidPrice);
    let market = &mut ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;
    market.accrue_borrow(now)?;
    market.price = price;
    market.price_updated_at = now;
    Ok(())
}
