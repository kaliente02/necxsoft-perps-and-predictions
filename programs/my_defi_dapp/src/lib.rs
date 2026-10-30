pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("4WLW48GwhBK9vtzL5GSbAUNioBVH5iFL6QKwGYNxMd8B");

/// Pool-based perpetual futures exchange: traders open leveraged long/short positions
/// against a shared USDC liquidity pool whose LPs earn fees and take the other side.
#[program]
pub mod my_defi_dapp {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, params: RiskParams) -> Result<()> {
        crate::instructions::initialize::handle_initialize(ctx, params)
    }

    pub fn add_market(
        ctx: Context<AddMarket>,
        symbol: String,
        oracle_authority: Pubkey,
        initial_price: u64,
        hourly_borrow_rate: u64,
        max_open_interest: u64,
    ) -> Result<()> {
        crate::instructions::admin::handle_add_market(
            ctx,
            symbol,
            oracle_authority,
            initial_price,
            hourly_borrow_rate,
            max_open_interest,
        )
    }

    pub fn update_exchange(
        ctx: Context<UpdateExchange>,
        params: RiskParams,
        paused: bool,
    ) -> Result<()> {
        crate::instructions::admin::handle_update_exchange(ctx, params, paused)
    }

    pub fn update_market(
        ctx: Context<UpdateMarket>,
        oracle_authority: Pubkey,
        hourly_borrow_rate: u64,
        max_open_interest: u64,
    ) -> Result<()> {
        crate::instructions::admin::handle_update_market(
            ctx,
            oracle_authority,
            hourly_borrow_rate,
            max_open_interest,
        )
    }

    pub fn configure_market(ctx: Context<ConfigureMarket>, max_hourly_funding_rate: u64) -> Result<()> {
        crate::instructions::admin::handle_configure_market(ctx, max_hourly_funding_rate)
    }

    pub fn update_price(ctx: Context<UpdatePrice>, price: u64) -> Result<()> {
        crate::instructions::update_price::handle_update_price(ctx, price)
    }

    pub fn add_liquidity<'info>(
        ctx: Context<'info, Liquidity<'info>>,
        amount: u64,
        min_lp_out: u64,
    ) -> Result<()> {
        crate::instructions::liquidity::handle_add_liquidity(ctx, amount, min_lp_out)
    }

    pub fn remove_liquidity<'info>(
        ctx: Context<'info, Liquidity<'info>>,
        lp_amount: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        crate::instructions::liquidity::handle_remove_liquidity(ctx, lp_amount, min_amount_out)
    }

    pub fn increase_position(
        ctx: Context<IncreasePosition>,
        side: Side,
        collateral_amount: u64,
        size_delta_usd: u64,
        price_limit: u64,
    ) -> Result<()> {
        crate::instructions::trade::handle_increase_position(
            ctx,
            side,
            collateral_amount,
            size_delta_usd,
            price_limit,
        )
    }

    pub fn close_position(ctx: Context<ClosePosition>, price_limit: u64) -> Result<()> {
        crate::instructions::trade::handle_close_position(ctx, price_limit)
    }

    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        crate::instructions::liquidate::handle_liquidate(ctx)
    }

    pub fn decrease_position(
        ctx: Context<DecreasePosition>,
        size_delta_usd: u64,
        collateral_out: u64,
        price_limit: u64,
    ) -> Result<()> {
        crate::instructions::trade::handle_decrease_position(ctx, size_delta_usd, collateral_out, price_limit)
    }

    pub fn place_order(
        ctx: Context<PlaceOrder>,
        id: u64,
        side: Side,
        kind: OrderKind,
        trigger_price: u64,
        size_usd: u64,
        collateral: u64,
    ) -> Result<()> {
        crate::instructions::orders::handle_place_order(ctx, id, side, kind, trigger_price, size_usd, collateral)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        crate::instructions::orders::handle_cancel_order(ctx)
    }

    pub fn execute_limit_order(ctx: Context<ExecuteLimitOrder>) -> Result<()> {
        crate::instructions::orders::handle_execute_limit_order(ctx)
    }

    pub fn execute_trigger_order(ctx: Context<ExecuteTriggerOrder>) -> Result<()> {
        crate::instructions::orders::handle_execute_trigger_order(ctx)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_prediction(
        ctx: Context<CreatePrediction>,
        id: u64,
        question: String,
        strike: u64,
        close_time: i64,
        liquidity: u64,
        initial_yes_bps: u16,
        fee_bps: u16,
    ) -> Result<()> {
        crate::instructions::predict::handle_create_prediction(
            ctx,
            id,
            question,
            strike,
            close_time,
            liquidity,
            initial_yes_bps,
            fee_bps,
        )
    }

    pub fn buy_shares(ctx: Context<BuyShares>, outcome: Outcome, amount: u64, min_shares_out: u64) -> Result<()> {
        crate::instructions::predict::handle_buy_shares(ctx, outcome, amount, min_shares_out)
    }

    pub fn sell_shares(ctx: Context<SellShares>, outcome: Outcome, shares: u64, min_amount_out: u64) -> Result<()> {
        crate::instructions::predict::handle_sell_shares(ctx, outcome, shares, min_amount_out)
    }

    pub fn resolve_price_market(ctx: Context<ResolvePriceMarket>) -> Result<()> {
        crate::instructions::predict::handle_resolve_price_market(ctx)
    }

    pub fn resolve_prediction(ctx: Context<ResolvePrediction>, outcome: Outcome) -> Result<()> {
        crate::instructions::predict::handle_resolve_prediction(ctx, outcome)
    }

    pub fn redeem_shares(ctx: Context<RedeemShares>) -> Result<()> {
        crate::instructions::predict::handle_redeem_shares(ctx)
    }

    pub fn withdraw_prediction_liquidity(ctx: Context<WithdrawPredictionLiquidity>) -> Result<()> {
        crate::instructions::predict::handle_withdraw_prediction_liquidity(ctx)
    }
}
