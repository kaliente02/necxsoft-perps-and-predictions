use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use super::{
    apply_close, apply_decrease, apply_increase, init_position, transfer_from_vault, transfer_to_vault,
};
use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(has_one = exchange)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init,
        payer = owner,
        space = 8 + Order::INIT_SPACE,
        seeds = [ORDER_SEED, owner.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub order: Box<Account<'info, Order>>,
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

/// Place a resting order. Limit orders escrow their collateral in the vault; take-profit and
/// stop-loss orders close `size_usd` of the matching position (0 = all of it) when triggered.
pub fn handle_place_order(
    ctx: Context<PlaceOrder>,
    id: u64,
    side: Side,
    kind: OrderKind,
    trigger_price: u64,
    size_usd: u64,
    collateral: u64,
) -> Result<()> {
    let accounts = &mut *ctx.accounts;
    let exchange = &mut accounts.exchange;
    let params = exchange.params;
    require!(trigger_price > 0, ErrorCode::InvalidPrice);

    if kind == OrderKind::Limit {
        require!(!exchange.paused, ErrorCode::Paused);
        require!(size_usd > 0 && collateral > 0, ErrorCode::ZeroAmount);
        require!(
            collateral >= params.min_collateral,
            ErrorCode::CollateralTooSmall
        );
        require!(
            (size_usd as u128) <= (collateral as u128) * params.max_leverage as u128,
            ErrorCode::LeverageTooHigh
        );
        // Escrowed collateral is trader-owned, so it is counted with position collateral.
        exchange.total_collateral = exchange
            .total_collateral
            .checked_add(collateral)
            .ok_or(ErrorCode::MathOverflow)?;
        transfer_to_vault(
            &accounts.token_program,
            &accounts.user_collateral,
            &accounts.vault,
            &accounts.owner,
            collateral,
        )?;
    } else {
        require!(collateral == 0, ErrorCode::InvalidOrder);
    }

    accounts.order.set_inner(Order {
        owner: accounts.owner.key(),
        market: accounts.market.key(),
        side,
        kind,
        trigger_price,
        trigger_above: Order::trigger_above(kind, side),
        size_usd,
        collateral,
        id,
        created_at: Clock::get()?.unix_timestamp,
        bump: ctx.bumps.order,
    });

    emit!(OrderPlaced {
        owner: accounts.owner.key(),
        order: accounts.order.key(),
        market: accounts.market.key(),
        side,
        kind,
        trigger_price,
        size_usd,
        collateral,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(
        mut,
        close = owner,
        has_one = owner,
        seeds = [ORDER_SEED, owner.key().as_ref(), &order.id.to_le_bytes()],
        bump = order.bump,
    )]
    pub order: Box<Account<'info, Order>>,
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

/// Cancel an order, refunding any escrowed collateral and the account rent.
pub fn handle_cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
    let accounts = &mut *ctx.accounts;
    let escrow = accounts.order.collateral;
    accounts.exchange.total_collateral = accounts
        .exchange
        .total_collateral
        .checked_sub(escrow)
        .ok_or(ErrorCode::MathOverflow)?;
    transfer_from_vault(
        &accounts.token_program,
        &accounts.vault,
        &accounts.user_collateral,
        &accounts.exchange,
        escrow,
    )?;
    emit!(OrderCancelled {
        owner: accounts.owner.key(),
        order: accounts.order.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteLimitOrder<'info> {
    /// Anyone may fill a triggered order; the executor pays position rent and keeps the order's.
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, has_one = exchange)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut,
        close = executor,
        has_one = owner,
        has_one = market,
        constraint = order.kind == OrderKind::Limit @ ErrorCode::InvalidOrder,
        seeds = [ORDER_SEED, owner.key().as_ref(), &order.id.to_le_bytes()],
        bump = order.bump,
    )]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the order's owner, validated by `has_one = owner`; included so fills show in its history.
    pub owner: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = executor,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref(), &[order.side as u8]],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    pub system_program: Program<'info, System>,
}

/// Fill a triggered limit order at the oracle price using its escrowed collateral.
pub fn handle_execute_limit_order(ctx: Context<ExecuteLimitOrder>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &mut *ctx.accounts;
    let exchange = &mut accounts.exchange;
    let market = &mut accounts.market;
    let position = &mut accounts.position;
    let order = &accounts.order;
    require!(!exchange.paused, ErrorCode::Paused);

    market.accrue_borrow(now)?;
    let price = market.fresh_price(now, exchange.params.max_price_age_secs)?;
    require!(order.triggered(price), ErrorCode::OrderNotTriggered);
    if position.size_usd == 0 {
        init_position(position, order.owner, market, order.side, now, ctx.bumps.position);
    }

    // The escrow is already in the vault and in total_collateral; apply_increase re-adds it net of fees.
    exchange.total_collateral = exchange
        .total_collateral
        .checked_sub(order.collateral)
        .ok_or(ErrorCode::MathOverflow)?;
    let fees = apply_increase(exchange, market, position, order.collateral, order.size_usd, price, now)?;

    emit!(PositionIncreased {
        owner: order.owner,
        market: market.key(),
        side: order.side,
        price,
        size_delta: order.size_usd,
        collateral_delta: order.collateral,
        fee: fees,
    });
    emit!(OrderExecuted {
        owner: order.owner,
        order: order.key(),
        executor: accounts.executor.key(),
        kind: order.kind,
        price,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteTriggerOrder<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, has_one = exchange)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut,
        close = executor,
        has_one = owner,
        has_one = market,
        constraint = order.kind != OrderKind::Limit @ ErrorCode::InvalidOrder,
        seeds = [ORDER_SEED, owner.key().as_ref(), &order.id.to_le_bytes()],
        bump = order.bump,
    )]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the order's owner, validated by `has_one = owner`; receives the position rent on a full close.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        has_one = owner,
        has_one = market,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref(), &[order.side as u8]],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(
        mut,
        token::mint = exchange.collateral_mint,
        token::authority = owner,
    )]
    pub owner_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = exchange.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Fill a triggered take-profit or stop-loss at the oracle price, closing part or all of the position.
pub fn handle_execute_trigger_order(ctx: Context<ExecuteTriggerOrder>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &mut *ctx.accounts;
    let exchange = &mut accounts.exchange;
    let market = &mut accounts.market;
    let position = &mut accounts.position;
    let order = &accounts.order;

    market.accrue_borrow(now)?;
    let price = market.fresh_price(now, exchange.params.max_price_age_secs)?;
    require!(order.triggered(price), ErrorCode::OrderNotTriggered);

    let size_usd = position.size_usd;
    let full_close = order.size_usd == 0 || order.size_usd >= size_usd;
    let payout = if full_close {
        let (pnl, payout) = apply_close(exchange, market, position, price)?;
        emit!(PositionClosed {
            owner: position.owner,
            market: market.key(),
            side: position.side,
            price,
            size_usd,
            pnl: pnl as i64,
            payout,
            collateral: position.collateral,
        });
        payout
    } else {
        // Withdraw collateral in proportion to the closed size so leverage stays the same.
        let collateral_out =
            mul_div(position.collateral as u128, order.size_usd as u128, size_usd as u128) as u64;
        let decrease = apply_decrease(exchange, market, position, order.size_usd, collateral_out, price, now)?;
        emit!(PositionDecreased {
            owner: position.owner,
            market: market.key(),
            side: position.side,
            price,
            size_delta: order.size_usd,
            pnl: decrease.pnl as i64,
            fee: decrease.fees,
            payout: decrease.payout,
        });
        decrease.payout
    };

    transfer_from_vault(
        &accounts.token_program,
        &accounts.vault,
        &accounts.owner_collateral,
        exchange,
        payout,
    )?;
    if full_close {
        position.close(accounts.owner.to_account_info())?;
    }

    emit!(OrderExecuted {
        owner: order.owner,
        order: order.key(),
        executor: accounts.executor.key(),
        kind: order.kind,
        price,
    });
    Ok(())
}
