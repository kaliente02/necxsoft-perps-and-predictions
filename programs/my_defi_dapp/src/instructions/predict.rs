use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::{constants::*, error::ErrorCode, state::*};

/// Transfer tokens out of a prediction market's vault, signed by the market PDA.
fn transfer_from_prediction<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    prediction: &Account<'info, PredictionMarket>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let id = prediction.id.to_le_bytes();
    let bump = [prediction.bump];
    let seeds: &[&[u8]] = &[PREDICTION_SEED, &id, &bump];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: vault.to_account_info(),
                to: to.to_account_info(),
                authority: prediction.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

fn transfer_to_prediction<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    vault: &Account<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
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

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreatePrediction<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ ErrorCode::Unauthorized,
    )]
    pub exchange: Box<Account<'info, Exchange>>,
    /// The perps market that settles a price market; omit for a custom question.
    #[account(has_one = exchange)]
    pub oracle_market: Option<Box<Account<'info, Market>>>,
    #[account(
        init,
        payer = admin,
        space = 8 + PredictionMarket::INIT_SPACE,
        seeds = [PREDICTION_SEED, &id.to_le_bytes()],
        bump
    )]
    pub prediction: Box<Account<'info, PredictionMarket>>,
    #[account(address = exchange.collateral_mint)]
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        seeds = [PREDICTION_VAULT_SEED, prediction.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = prediction,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = exchange.collateral_mint,
        token::authority = admin,
    )]
    pub admin_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Create a YES/NO market and seed its AMM with `liquidity` USDC at `initial_yes_bps` probability.
#[allow(clippy::too_many_arguments)]
pub fn handle_create_prediction(
    ctx: Context<CreatePrediction>,
    id: u64,
    question: String,
    strike: u64,
    close_time: i64,
    liquidity: u64,
    initial_yes_bps: u16,
    fee_bps: u16,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        !question.is_empty() && question.len() <= MAX_QUESTION_LEN,
        ErrorCode::InvalidQuestion
    );
    require!(close_time > now, ErrorCode::InvalidPrediction);
    require!(liquidity > 0, ErrorCode::ZeroAmount);
    require!(
        (500..=9_500).contains(&initial_yes_bps) && fee_bps <= MAX_PREDICTION_FEE_BPS,
        ErrorCode::InvalidPrediction
    );
    let oracle_market = match &ctx.accounts.oracle_market {
        Some(market) => {
            require!(strike > 0, ErrorCode::InvalidPrice);
            market.key()
        }
        None => Pubkey::default(),
    };

    // YES price = no / (yes + no). The larger reserve holds every seeded set; the creator keeps
    // the shares the smaller reserve leaves over.
    let p = initial_yes_bps as u128;
    let l = liquidity as u128;
    let (yes_reserve, no_reserve) = if p >= 5_000 {
        ((l * (10_000 - p) / p) as u64, liquidity)
    } else {
        (liquidity, (l * p / (10_000 - p)) as u64)
    };
    require!(yes_reserve > 0 && no_reserve > 0, ErrorCode::InvalidPrediction);

    transfer_to_prediction(
        &ctx.accounts.token_program,
        &ctx.accounts.admin_collateral,
        &ctx.accounts.vault,
        &ctx.accounts.admin,
        liquidity,
    )?;

    ctx.accounts.prediction.set_inner(PredictionMarket {
        exchange: ctx.accounts.exchange.key(),
        creator: ctx.accounts.admin.key(),
        id,
        question: question.clone(),
        oracle_market,
        strike,
        close_time,
        yes_reserve,
        no_reserve,
        creator_yes: liquidity - yes_reserve,
        creator_no: liquidity - no_reserve,
        total_sets: liquidity,
        fee_bps,
        initial_yes_bps,
        fees: 0,
        volume: 0,
        resolved: false,
        outcome: Outcome::Invalid,
        resolved_price: 0,
        resolved_at: 0,
        created_at: now,
        bump: ctx.bumps.prediction,
        vault_bump: ctx.bumps.vault,
    });

    emit!(PredictionCreated {
        market: ctx.accounts.prediction.key(),
        question,
        oracle_market,
        strike,
        close_time,
        liquidity,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct BuyShares<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, has_one = exchange)]
    pub prediction: Box<Account<'info, PredictionMarket>>,
    #[account(
        mut,
        seeds = [PREDICTION_VAULT_SEED, prediction.key().as_ref()],
        bump = prediction.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = trader,
        space = 8 + PredictionPosition::INIT_SPACE,
        seeds = [PREDICTION_POSITION_SEED, prediction.key().as_ref(), trader.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, PredictionPosition>>,
    #[account(
        mut,
        token::mint = exchange.collateral_mint,
        token::authority = trader,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

fn require_open(exchange: &Exchange, prediction: &PredictionMarket, outcome: Outcome) -> Result<()> {
    require!(!exchange.paused, ErrorCode::Paused);
    require!(
        !prediction.resolved && Clock::get()?.unix_timestamp < prediction.close_time,
        ErrorCode::PredictionClosed
    );
    require!(outcome != Outcome::Invalid, ErrorCode::InvalidPrediction);
    Ok(())
}

/// Spend `amount` USDC (fee included) on YES or NO shares.
pub fn handle_buy_shares(
    ctx: Context<BuyShares>,
    outcome: Outcome,
    amount: u64,
    min_shares_out: u64,
) -> Result<()> {
    let accounts = &mut *ctx.accounts;
    require_open(&accounts.exchange, &accounts.prediction, outcome)?;
    require!(amount > 0, ErrorCode::ZeroAmount);

    let prediction = &mut accounts.prediction;
    let fee = bps_of(amount, prediction.fee_bps);
    let shares = prediction.buy(outcome, amount - fee)?;
    require!(shares > 0 && shares >= min_shares_out, ErrorCode::SlippageExceeded);
    prediction.fees += fee;
    prediction.volume = prediction.volume.saturating_add(amount);

    let position = &mut accounts.position;
    if position.owner == Pubkey::default() {
        position.owner = accounts.trader.key();
        position.market = prediction.key();
        position.bump = ctx.bumps.position;
    }
    *position.shares_mut(outcome) += shares;
    position.net_cost = position.net_cost.saturating_add(amount as i64);

    transfer_to_prediction(
        &accounts.token_program,
        &accounts.user_collateral,
        &accounts.vault,
        &accounts.trader,
        amount,
    )?;

    emit!(SharesTraded {
        market: prediction.key(),
        owner: accounts.trader.key(),
        outcome,
        buy: true,
        shares,
        amount,
        fee,
        yes_price_bps: prediction.yes_price_bps(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SellShares<'info> {
    pub trader: Signer<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, has_one = exchange)]
    pub prediction: Box<Account<'info, PredictionMarket>>,
    #[account(
        mut,
        seeds = [PREDICTION_VAULT_SEED, prediction.key().as_ref()],
        bump = prediction.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [PREDICTION_POSITION_SEED, prediction.key().as_ref(), trader.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, PredictionPosition>>,
    #[account(
        mut,
        token::mint = exchange.collateral_mint,
        token::authority = trader,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Sell YES or NO shares back to the AMM before the market closes.
pub fn handle_sell_shares(
    ctx: Context<SellShares>,
    outcome: Outcome,
    shares: u64,
    min_amount_out: u64,
) -> Result<()> {
    let accounts = &mut *ctx.accounts;
    require_open(&accounts.exchange, &accounts.prediction, outcome)?;
    require!(shares > 0, ErrorCode::ZeroAmount);
    let held = accounts.position.shares_mut(outcome);
    require!(*held >= shares, ErrorCode::InsufficientShares);
    *held -= shares;

    let prediction = &mut accounts.prediction;
    let gross = prediction.sell(outcome, shares)?;
    let fee = bps_of(gross, prediction.fee_bps);
    let amount = gross - fee;
    require!(amount > 0 && amount >= min_amount_out, ErrorCode::SlippageExceeded);
    // The fee stays in the vault: the sets it backed were burned, so it is no longer a share claim.
    prediction.fees += fee;
    prediction.volume = prediction.volume.saturating_add(gross);
    accounts.position.net_cost = accounts.position.net_cost.saturating_sub(amount as i64);

    transfer_from_prediction(
        &accounts.token_program,
        &accounts.vault,
        &accounts.user_collateral,
        prediction,
        amount,
    )?;

    emit!(SharesTraded {
        market: prediction.key(),
        owner: accounts.trader.key(),
        outcome,
        buy: false,
        shares,
        amount,
        fee,
        yes_price_bps: prediction.yes_price_bps(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolvePriceMarket<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, has_one = exchange, has_one = oracle_market)]
    pub prediction: Box<Account<'info, PredictionMarket>>,
    #[account(has_one = exchange)]
    pub oracle_market: Box<Account<'info, Market>>,
}

/// Permissionless: settle a price market from the first fresh oracle price at or after close.
pub fn handle_resolve_price_market(ctx: Context<ResolvePriceMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let prediction = &mut ctx.accounts.prediction;
    let oracle = &ctx.accounts.oracle_market;
    require!(!prediction.resolved, ErrorCode::PredictionClosed);
    require!(prediction.is_price_market(), ErrorCode::WrongResolution);
    require!(
        now >= prediction.close_time && oracle.price_updated_at >= prediction.close_time,
        ErrorCode::ResolutionTooEarly
    );
    let price = oracle.fresh_price(now, ctx.accounts.exchange.params.max_price_age_secs)?;
    let outcome = if price >= prediction.strike {
        Outcome::Yes
    } else {
        Outcome::No
    };
    resolve(prediction, outcome, price, now)
}

#[derive(Accounts)]
pub struct ResolvePrediction<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ ErrorCode::Unauthorized,
    )]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, has_one = exchange)]
    pub prediction: Box<Account<'info, PredictionMarket>>,
}

/// Admin: settle a custom question. Price markets can only be voided (Invalid), after close,
/// as an escape hatch if the oracle stops updating.
pub fn handle_resolve_prediction(ctx: Context<ResolvePrediction>, outcome: Outcome) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let prediction = &mut ctx.accounts.prediction;
    require!(!prediction.resolved, ErrorCode::PredictionClosed);
    if prediction.is_price_market() {
        require!(outcome == Outcome::Invalid, ErrorCode::WrongResolution);
        require!(now >= prediction.close_time, ErrorCode::ResolutionTooEarly);
    }
    resolve(prediction, outcome, 0, now)
}

fn resolve(prediction: &mut Account<PredictionMarket>, outcome: Outcome, price: u64, now: i64) -> Result<()> {
    prediction.resolved = true;
    prediction.outcome = outcome;
    prediction.resolved_price = price;
    prediction.resolved_at = now;
    emit!(PredictionResolved {
        market: prediction.key(),
        outcome,
        price,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RedeemShares<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(has_one = exchange)]
    pub prediction: Box<Account<'info, PredictionMarket>>,
    #[account(
        mut,
        seeds = [PREDICTION_VAULT_SEED, prediction.key().as_ref()],
        bump = prediction.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        close = owner,
        has_one = owner,
        seeds = [PREDICTION_POSITION_SEED, prediction.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, PredictionPosition>>,
    #[account(
        mut,
        token::mint = exchange.collateral_mint,
        token::authority = owner,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Redeem winning shares for USDC after resolution and close the position.
pub fn handle_redeem_shares(ctx: Context<RedeemShares>) -> Result<()> {
    let prediction = &ctx.accounts.prediction;
    require!(prediction.resolved, ErrorCode::PredictionNotResolved);
    let position = &ctx.accounts.position;
    let payout = prediction.payout(position.yes_shares, position.no_shares);
    transfer_from_prediction(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.user_collateral,
        prediction,
        payout,
    )?;
    emit!(PredictionRedeemed {
        market: prediction.key(),
        owner: ctx.accounts.owner.key(),
        payout,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawPredictionLiquidity<'info> {
    pub creator: Signer<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, has_one = exchange, has_one = creator @ ErrorCode::Unauthorized)]
    pub prediction: Box<Account<'info, PredictionMarket>>,
    #[account(
        mut,
        seeds = [PREDICTION_VAULT_SEED, prediction.key().as_ref()],
        bump = prediction.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = exchange.collateral_mint,
        token::authority = creator,
    )]
    pub creator_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Creator: after resolution, withdraw what the pool's shares are worth plus trading fees.
pub fn handle_withdraw_prediction_liquidity(ctx: Context<WithdrawPredictionLiquidity>) -> Result<()> {
    let prediction = &mut ctx.accounts.prediction;
    require!(prediction.resolved, ErrorCode::PredictionNotResolved);
    let yes = prediction.yes_reserve + prediction.creator_yes;
    let no = prediction.no_reserve + prediction.creator_no;
    let amount = prediction.payout(yes, no) + prediction.fees;
    prediction.yes_reserve = 0;
    prediction.no_reserve = 0;
    prediction.creator_yes = 0;
    prediction.creator_no = 0;
    prediction.fees = 0;
    transfer_from_prediction(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.creator_collateral,
        prediction,
        amount,
    )?;
    emit!(PredictionRedeemed {
        market: prediction.key(),
        owner: ctx.accounts.creator.key(),
        payout: amount,
    });
    Ok(())
}
