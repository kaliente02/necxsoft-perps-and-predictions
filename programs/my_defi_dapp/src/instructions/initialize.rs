use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{constants::*, state::*};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Exchange::INIT_SPACE,
        seeds = [EXCHANGE_SEED],
        bump
    )]
    pub exchange: Account<'info, Exchange>,
    #[account(mint::decimals = USD_DECIMALS)]
    pub collateral_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, exchange.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = exchange,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        seeds = [LP_MINT_SEED, exchange.key().as_ref()],
        bump,
        mint::decimals = USD_DECIMALS,
        mint::authority = exchange,
    )]
    pub lp_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, params: RiskParams) -> Result<()> {
    params.validate()?;
    ctx.accounts.exchange.set_inner(Exchange {
        admin: ctx.accounts.admin.key(),
        collateral_mint: ctx.accounts.collateral_mint.key(),
        vault: ctx.accounts.vault.key(),
        lp_mint: ctx.accounts.lp_mint.key(),
        pool_balance: 0,
        total_collateral: 0,
        total_open_interest: 0,
        num_markets: 0,
        paused: false,
        params,
        bump: ctx.bumps.exchange,
        vault_bump: ctx.bumps.vault,
        lp_mint_bump: ctx.bumps.lp_mint,
    });
    Ok(())
}
