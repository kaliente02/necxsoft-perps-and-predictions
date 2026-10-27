use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};

use super::{pool_aum, transfer_from_vault, transfer_to_vault};
use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct Liquidity<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, address = exchange.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = exchange.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        token::mint = exchange.collateral_mint,
        token::authority = owner,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = lp_mint, token::authority = owner)]
    pub user_lp: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: every Market of the exchange (read-only), used to value the pool.
}

/// Deposit collateral into the pool and receive LP tokens.
pub fn handle_add_liquidity<'info>(
    ctx: Context<'info, Liquidity<'info>>,
    amount: u64,
    min_lp_out: u64,
) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    require!(!accounts.exchange.paused, ErrorCode::Paused);

    let aum = pool_aum(
        &accounts.exchange,
        &accounts.exchange.key(),
        ctx.remaining_accounts,
        now,
    )?;
    let supply = accounts.lp_mint.supply;
    let lp_out = if supply == 0 || aum == 0 {
        amount
    } else {
        mul_div(amount as u128, supply as u128, aum as u128) as u64
    };
    require!(lp_out > 0 && lp_out >= min_lp_out, ErrorCode::MinOutputNotMet);

    transfer_to_vault(
        &accounts.token_program,
        &accounts.user_collateral,
        &accounts.vault,
        &accounts.owner,
        amount,
    )?;

    let bump = [accounts.exchange.bump];
    let seeds: &[&[u8]] = &[EXCHANGE_SEED, &bump];
    token::mint_to(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            MintTo {
                mint: accounts.lp_mint.to_account_info(),
                to: accounts.user_lp.to_account_info(),
                authority: accounts.exchange.to_account_info(),
            },
            &[seeds],
        ),
        lp_out,
    )?;

    let exchange = &mut ctx.accounts.exchange;
    exchange.pool_balance = exchange
        .pool_balance
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;

    emit!(LiquidityChanged {
        owner: ctx.accounts.owner.key(),
        collateral_amount: amount,
        lp_amount: lp_out,
        deposit: true,
    });
    Ok(())
}

/// Burn LP tokens and withdraw the proportional share of pool assets.
pub fn handle_remove_liquidity<'info>(
    ctx: Context<'info, Liquidity<'info>>,
    lp_amount: u64,
    min_amount_out: u64,
) -> Result<()> {
    require!(lp_amount > 0, ErrorCode::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;

    let aum = pool_aum(
        &accounts.exchange,
        &accounts.exchange.key(),
        ctx.remaining_accounts,
        now,
    )?;
    let supply = accounts.lp_mint.supply;
    require!(supply > 0, ErrorCode::InsufficientPoolLiquidity);
    let amount_out = mul_div(lp_amount as u128, aum as u128, supply as u128) as u64;
    require!(
        amount_out > 0 && amount_out >= min_amount_out,
        ErrorCode::MinOutputNotMet
    );

    let pool_after = accounts
        .exchange
        .pool_balance
        .checked_sub(amount_out)
        .ok_or(ErrorCode::InsufficientPoolLiquidity)?;
    // Withdrawals may not push open interest above the utilization cap.
    let max_oi_after = mul_div(
        pool_after as u128,
        accounts.exchange.params.max_utilization_bps as u128,
        BPS_DENOMINATOR as u128,
    ) as u64;
    require!(
        accounts.exchange.total_open_interest <= max_oi_after,
        ErrorCode::PoolUtilizationCap
    );

    token::burn(
        CpiContext::new(
            accounts.token_program.key(),
            Burn {
                mint: accounts.lp_mint.to_account_info(),
                from: accounts.user_lp.to_account_info(),
                authority: accounts.owner.to_account_info(),
            },
        ),
        lp_amount,
    )?;
    transfer_from_vault(
        &accounts.token_program,
        &accounts.vault,
        &accounts.user_collateral,
        &accounts.exchange,
        amount_out,
    )?;

    ctx.accounts.exchange.pool_balance = pool_after;

    emit!(LiquidityChanged {
        owner: ctx.accounts.owner.key(),
        collateral_amount: amount_out,
        lp_amount,
        deposit: false,
    });
    Ok(())
}
