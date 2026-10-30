use anchor_lang::prelude::*;

#[constant]
pub const EXCHANGE_SEED: &[u8] = b"exchange";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

#[constant]
pub const LP_MINT_SEED: &[u8] = b"lp_mint";

#[constant]
pub const MARKET_SEED: &[u8] = b"market";

#[constant]
pub const POSITION_SEED: &[u8] = b"position";

#[constant]
pub const ORDER_SEED: &[u8] = b"order";

/// USD amounts, prices and the collateral token (USDC) all use 6 decimals.
#[constant]
pub const USD_DECIMALS: u8 = 6;

#[constant]
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Fixed-point scale for position "base" amounts (size_usd / entry_price).
pub const BASE_SCALE: u128 = 1_000_000_000;

/// Fixed-point scale for the cumulative borrow-fee index and hourly borrow rates.
pub const BORROW_RATE_SCALE: u128 = 1_000_000_000;

pub const SECONDS_PER_HOUR: i64 = 3_600;

#[constant]
pub const MAX_MARKETS: u8 = 16;

pub const MAX_SYMBOL_LEN: usize = 16;

/// Hard upper bound for any exchange's leverage setting.
pub const MAX_LEVERAGE_CAP: u16 = 100;

#[constant]
pub const PREDICTION_SEED: &[u8] = b"prediction";

#[constant]
pub const PREDICTION_VAULT_SEED: &[u8] = b"prediction_vault";

#[constant]
pub const PREDICTION_POSITION_SEED: &[u8] = b"prediction_position";

pub const MAX_QUESTION_LEN: usize = 160;

/// Hard upper bound for a prediction market's trading fee.
pub const MAX_PREDICTION_FEE_BPS: u16 = 1_000;

#[constant]
pub const HISTORY_SEED: &[u8] = b"history";

#[constant]
pub const LIQUIDATION_FEED_SEED: &[u8] = b"liquidations";

/// Hourly samples kept per market (one week).
pub const HISTORY_LEN: usize = 168;

/// Most recent liquidations kept in the exchange-wide feed.
pub const LIQUIDATION_FEED_LEN: usize = 50;

/// Hard upper bound for a market's full-skew funding rate: 1% per hour.
pub const MAX_HOURLY_FUNDING_RATE: u64 = 10_000_000;
