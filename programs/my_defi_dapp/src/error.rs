use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the exchange admin can perform this action")]
    Unauthorized,
    #[msg("Only the market's oracle authority can update its price")]
    InvalidOracleAuthority,
    #[msg("Invalid risk parameters")]
    InvalidRiskParams,
    #[msg("Market symbol must be 1-16 bytes")]
    InvalidSymbol,
    #[msg("Maximum number of markets reached")]
    TooManyMarkets,
    #[msg("Price must be greater than zero")]
    InvalidPrice,
    #[msg("Oracle price is stale")]
    StalePrice,
    #[msg("Execution price is worse than the price limit")]
    SlippageExceeded,
    #[msg("Exchange is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Collateral is below the exchange minimum")]
    CollateralTooSmall,
    #[msg("Position exceeds maximum leverage")]
    LeverageTooHigh,
    #[msg("Position would be below maintenance margin")]
    InsufficientMargin,
    #[msg("Market open interest cap reached")]
    MarketOpenInterestCap,
    #[msg("Pool utilization cap reached")]
    PoolUtilizationCap,
    #[msg("Pool does not have enough liquidity")]
    InsufficientPoolLiquidity,
    #[msg("Every market of the exchange must be passed exactly once")]
    MarketsMismatch,
    #[msg("Account is not a market of this exchange")]
    InvalidMarketAccount,
    #[msg("Output is below the minimum requested")]
    MinOutputNotMet,
    #[msg("Position is healthy and cannot be liquidated")]
    NotLiquidatable,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Order trigger price has not been reached")]
    OrderNotTriggered,
    #[msg("Invalid order parameters")]
    InvalidOrder,
    #[msg("Decrease must leave part of the position open; use close_position to close it fully")]
    UseClosePosition,
    #[msg("Question must be 1-160 bytes")]
    InvalidQuestion,
    #[msg("Invalid prediction market parameters")]
    InvalidPrediction,
    #[msg("Prediction market is closed for trading")]
    PredictionClosed,
    #[msg("Prediction market is not resolved yet")]
    PredictionNotResolved,
    #[msg("Prediction market cannot be resolved yet")]
    ResolutionTooEarly,
    #[msg("Price markets resolve from the oracle; custom markets are resolved by the admin")]
    WrongResolution,
    #[msg("Not enough shares")]
    InsufficientShares,
}
