pub mod admin;
pub mod initialize;
pub mod liquidate;
pub mod liquidity;
pub mod orders;
pub mod predict;
pub mod trade;
pub mod update_price;

pub use admin::*;
pub use initialize::*;
pub use liquidate::*;
pub use liquidity::*;
pub use orders::*;
pub use predict::*;
pub use trade::*;
pub use update_price::*;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{constants::*, error::ErrorCode, state::*};

/// Transfer tokens out of the vault, signed by the exchange PDA.
pub(crate) fn transfer_from_vault<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    exchange: &Account<'info, Exchange>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump = [exchange.bump];
    let seeds: &[&[u8]] = &[EXCHANGE_SEED, &bump];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: vault.to_account_info(),
                to: to.to_account_info(),
                authority: exchange.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// Transfer tokens from a user-owned account into the vault.
pub(crate) fn transfer_to_vault<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    vault: &Account<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new(
            token_program.key(),
            Transfer {
                from: from.to_account_info(),
                to: vault.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
    )
}

/// Assets under management of the LP pool: pool balance minus traders' aggregate unrealized PnL.
/// `markets` must contain every market of the exchange exactly once, each with a fresh price.
pub(crate) fn pool_aum(
    exchange: &Exchange,
    exchange_key: &Pubkey,
    markets: &[AccountInfo],
    now: i64,
) -> Result<u64> {
    require!(
        markets.len() == exchange.num_markets as usize,
        ErrorCode::MarketsMismatch
    );
    let mut seen: u32 = 0;
    let mut trader_pnl: i128 = 0;
    for info in markets {
        require_keys_eq!(*info.owner, crate::ID, ErrorCode::InvalidMarketAccount);
        let data = info.try_borrow_data()?;
        let market = Market::try_deserialize(&mut &data[..])?;
        require_keys_eq!(market.exchange, *exchange_key, ErrorCode::InvalidMarketAccount);
        let bit = 1u32 << market.index;
        require!(seen & bit == 0, ErrorCode::MarketsMismatch);
        seen |= bit;
        let price = market.fresh_price(now, exchange.params.max_price_age_secs)?;
        trader_pnl += market.unrealized_trader_pnl(price);
    }
    Ok((exchange.pool_balance as i128 - trader_pnl).max(0) as u64)
}
