use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::token::spl_token,
    litesvm::LiteSVM,
    my_defi_dapp::{
        constants::*,
        state::{Exchange, Market, OrderKind, Outcome, Position, PredictionMarket, PredictionPosition, RiskParams, Side},
    },
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_program_pack::Pack,
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const USD: u64 = 1_000_000;
const SOL_PRICE: u64 = 100 * USD;

fn params() -> RiskParams {
    RiskParams {
        max_leverage: 50,
        trade_fee_bps: 10,
        maintenance_margin_bps: 100,
        liquidation_fee_bps: 50,
        max_utilization_bps: 8_000,
        max_price_age_secs: 60,
        min_collateral: 10 * USD,
    }
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    usdc: Pubkey,
    exchange: Pubkey,
    vault: Pubkey,
    lp_mint: Pubkey,
    market: Pubkey,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/my_defi_dapp.so"
        ));
        svm.add_program(my_defi_dapp::id(), bytes).unwrap();
        set_time(&mut svm, 1_700_000_000);

        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

        let usdc = Pubkey::new_unique();
        let mut mint_data = vec![0u8; spl_token::state::Mint::LEN];
        spl_token::state::Mint {
            mint_authority: Some(admin.pubkey()).into(),
            supply: 0,
            decimals: 6,
            is_initialized: true,
            freeze_authority: None.into(),
        }
        .pack_into_slice(&mut mint_data);
        svm.set_account(usdc, token_program_account(mint_data)).unwrap();

        let pid = my_defi_dapp::id();
        let exchange = Pubkey::find_program_address(&[EXCHANGE_SEED], &pid).0;
        let vault = Pubkey::find_program_address(&[VAULT_SEED, exchange.as_ref()], &pid).0;
        let lp_mint = Pubkey::find_program_address(&[LP_MINT_SEED, exchange.as_ref()], &pid).0;
        let market = Pubkey::find_program_address(&[MARKET_SEED, exchange.as_ref(), &[0]], &pid).0;

        let mut env = Env {
            svm,
            admin,
            usdc,
            exchange,
            vault,
            lp_mint,
            market,
        };

        env.send(
            ix(
                my_defi_dapp::instruction::Initialize { params: params() },
                my_defi_dapp::accounts::Initialize {
                    admin: env.admin.pubkey(),
                    exchange,
                    collateral_mint: usdc,
                    vault,
                    lp_mint,
                    token_program: spl_token::ID,
                    system_program: system_program::ID,
                },
            ),
            &[&env.admin.insecure_clone()],
        )
        .unwrap();

        env.send(
            ix(
                my_defi_dapp::instruction::AddMarket {
                    symbol: "SOL-PERP".into(),
                    oracle_authority: env.admin.pubkey(),
                    initial_price: SOL_PRICE,
                    // 0.01% per hour
                    hourly_borrow_rate: 100_000,
                    max_open_interest: 1_000_000 * USD,
                },
                my_defi_dapp::accounts::AddMarket {
                    admin: env.admin.pubkey(),
                    exchange,
                    market,
                    system_program: system_program::ID,
                },
            ),
            &[&env.admin.insecure_clone()],
        )
        .unwrap();
        env
    }

    fn send(&mut self, instruction: Instruction, signers: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            &[instruction],
            Some(&signers[0].pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    /// Create a funded user with a USDC account and an LP token account.
    fn user(&mut self, usdc_amount: u64) -> (Keypair, Pubkey, Pubkey) {
        let user = Keypair::new();
        self.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
        let usdc_ata = self.token_account(self.usdc, user.pubkey(), usdc_amount);
        let lp_ata = self.token_account(self.lp_mint, user.pubkey(), 0);
        (user, usdc_ata, lp_ata)
    }

    fn token_account(&mut self, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
        let address = Pubkey::new_unique();
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        spl_token::state::Account {
            mint,
            owner,
            amount,
            delegate: None.into(),
            state: spl_token::state::AccountState::Initialized,
            is_native: None.into(),
            delegated_amount: 0,
            close_authority: None.into(),
        }
        .pack_into_slice(&mut data);
        self.svm
            .set_account(address, token_program_account(data))
            .unwrap();
        address
    }

    fn balance(&self, token_account: Pubkey) -> u64 {
        let account = self.svm.get_account(&token_account).unwrap();
        spl_token::state::Account::unpack(&account.data).unwrap().amount
    }

    fn exchange(&self) -> Exchange {
        self.load(self.exchange)
    }

    fn market(&self) -> Market {
        self.load(self.market)
    }

    fn load<T: AccountDeserialize>(&self, address: Pubkey) -> T {
        let account = self.svm.get_account(&address).unwrap();
        T::try_deserialize(&mut &account.data[..]).unwrap()
    }

    fn position_address(&self, owner: Pubkey, side: Side) -> Pubkey {
        Pubkey::find_program_address(
            &[
                POSITION_SEED,
                self.market.as_ref(),
                owner.as_ref(),
                &[side as u8],
            ],
            &my_defi_dapp::id(),
        )
        .0
    }

    fn set_price(&mut self, price: u64) {
        let admin = self.admin.insecure_clone();
        self.send(
            ix(
                my_defi_dapp::instruction::UpdatePrice { price },
                my_defi_dapp::accounts::UpdatePrice {
                    oracle_authority: admin.pubkey(),
                    market: self.market,
                },
            ),
            &[&admin],
        )
        .unwrap();
    }

    fn liquidity_ix(&self, owner: Pubkey, usdc: Pubkey, lp: Pubkey, data: impl InstructionData) -> Instruction {
        let mut instruction = ix(
            data,
            my_defi_dapp::accounts::Liquidity {
                owner,
                exchange: self.exchange,
                vault: self.vault,
                lp_mint: self.lp_mint,
                user_collateral: usdc,
                user_lp: lp,
                token_program: spl_token::ID,
            },
        );
        instruction
            .accounts
            .push(anchor_lang::prelude::AccountMeta::new_readonly(self.market, false));
        instruction
    }

    fn add_liquidity(&mut self, owner: &Keypair, usdc: Pubkey, lp: Pubkey, amount: u64) -> Result<(), String> {
        let instruction = self.liquidity_ix(
            owner.pubkey(),
            usdc,
            lp,
            my_defi_dapp::instruction::AddLiquidity { amount, min_lp_out: 0 },
        );
        self.send(instruction, &[owner])
    }

    fn remove_liquidity(&mut self, owner: &Keypair, usdc: Pubkey, lp: Pubkey, lp_amount: u64) -> Result<(), String> {
        let instruction = self.liquidity_ix(
            owner.pubkey(),
            usdc,
            lp,
            my_defi_dapp::instruction::RemoveLiquidity {
                lp_amount,
                min_amount_out: 0,
            },
        );
        self.send(instruction, &[owner])
    }

    fn increase(
        &mut self,
        owner: &Keypair,
        usdc: Pubkey,
        side: Side,
        collateral: u64,
        size: u64,
        price_limit: u64,
    ) -> Result<(), String> {
        let instruction = ix(
            my_defi_dapp::instruction::IncreasePosition {
                side,
                collateral_amount: collateral,
                size_delta_usd: size,
                price_limit,
            },
            my_defi_dapp::accounts::IncreasePosition {
                owner: owner.pubkey(),
                exchange: self.exchange,
                market: self.market,
                position: self.position_address(owner.pubkey(), side),
                vault: self.vault,
                user_collateral: usdc,
                token_program: spl_token::ID,
                system_program: system_program::ID,
            },
        );
        self.send(instruction, &[owner])
    }

    fn close(&mut self, owner: &Keypair, usdc: Pubkey, side: Side, price_limit: u64) -> Result<(), String> {
        let instruction = ix(
            my_defi_dapp::instruction::ClosePosition { price_limit },
            my_defi_dapp::accounts::ClosePosition {
                owner: owner.pubkey(),
                exchange: self.exchange,
                market: self.market,
                position: self.position_address(owner.pubkey(), side),
                vault: self.vault,
                user_collateral: usdc,
                token_program: spl_token::ID,
            },
        );
        self.send(instruction, &[owner])
    }

    fn liquidate(
        &mut self,
        liquidator: &Keypair,
        liquidator_usdc: Pubkey,
        owner: Pubkey,
        owner_usdc: Pubkey,
        side: Side,
    ) -> Result<(), String> {
        let instruction = ix(
            my_defi_dapp::instruction::Liquidate {},
            my_defi_dapp::accounts::Liquidate {
                liquidator: liquidator.pubkey(),
                exchange: self.exchange,
                market: self.market,
                position: self.position_address(owner, side),
                owner,
                owner_collateral: owner_usdc,
                liquidator_collateral: liquidator_usdc,
                vault: self.vault,
                token_program: spl_token::ID,
            },
        );
        self.send(instruction, &[liquidator])
    }

    fn decrease(
        &mut self,
        owner: &Keypair,
        usdc: Pubkey,
        side: Side,
        size: u64,
        collateral_out: u64,
        price_limit: u64,
    ) -> Result<(), String> {
        let instruction = ix(
            my_defi_dapp::instruction::DecreasePosition {
                size_delta_usd: size,
                collateral_out,
                price_limit,
            },
            my_defi_dapp::accounts::DecreasePosition {
                owner: owner.pubkey(),
                exchange: self.exchange,
                market: self.market,
                position: self.position_address(owner.pubkey(), side),
                vault: self.vault,
                user_collateral: usdc,
                token_program: spl_token::ID,
            },
        );
        self.send(instruction, &[owner])
    }

    fn order_address(&self, owner: Pubkey, id: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[ORDER_SEED, owner.as_ref(), &id.to_le_bytes()],
            &my_defi_dapp::id(),
        )
        .0
    }

    #[allow(clippy::too_many_arguments)]
    fn place_order(
        &mut self,
        owner: &Keypair,
        usdc: Pubkey,
        id: u64,
        side: Side,
        kind: OrderKind,
        trigger_price: u64,
        size: u64,
        collateral: u64,
    ) -> Result<(), String> {
        let instruction = ix(
            my_defi_dapp::instruction::PlaceOrder {
                id,
                side,
                kind,
                trigger_price,
                size_usd: size,
                collateral,
            },
            my_defi_dapp::accounts::PlaceOrder {
                owner: owner.pubkey(),
                exchange: self.exchange,
                market: self.market,
                order: self.order_address(owner.pubkey(), id),
                vault: self.vault,
                user_collateral: usdc,
                token_program: spl_token::ID,
                system_program: system_program::ID,
            },
        );
        self.send(instruction, &[owner])
    }

    fn cancel_order(&mut self, owner: &Keypair, usdc: Pubkey, id: u64) -> Result<(), String> {
        let instruction = ix(
            my_defi_dapp::instruction::CancelOrder {},
            my_defi_dapp::accounts::CancelOrder {
                owner: owner.pubkey(),
                exchange: self.exchange,
                order: self.order_address(owner.pubkey(), id),
                vault: self.vault,
                user_collateral: usdc,
                token_program: spl_token::ID,
            },
        );
        self.send(instruction, &[owner])
    }

    fn execute_limit(&mut self, executor: &Keypair, owner: Pubkey, id: u64, side: Side) -> Result<(), String> {
        let instruction = ix(
            my_defi_dapp::instruction::ExecuteLimitOrder {},
            my_defi_dapp::accounts::ExecuteLimitOrder {
                executor: executor.pubkey(),
                exchange: self.exchange,
                market: self.market,
                order: self.order_address(owner, id),
                owner,
                position: self.position_address(owner, side),
                system_program: system_program::ID,
            },
        );
        self.send(instruction, &[executor])
    }

    fn execute_trigger(
        &mut self,
        executor: &Keypair,
        owner: Pubkey,
        owner_usdc: Pubkey,
        id: u64,
        side: Side,
    ) -> Result<(), String> {
        let instruction = ix(
            my_defi_dapp::instruction::ExecuteTriggerOrder {},
            my_defi_dapp::accounts::ExecuteTriggerOrder {
                executor: executor.pubkey(),
                exchange: self.exchange,
                market: self.market,
                order: self.order_address(owner, id),
                owner,
                position: self.position_address(owner, side),
                owner_collateral: owner_usdc,
                vault: self.vault,
                token_program: spl_token::ID,
            },
        );
        self.send(instruction, &[executor])
    }

    fn is_closed(&self, address: Pubkey) -> bool {
        self.svm.get_account(&address).map_or(true, |a| a.lamports == 0)
    }

    /// The vault must always hold exactly LP assets + trader collateral.
    fn assert_solvent(&self) {
        let exchange = self.exchange();
        assert_eq!(
            self.balance(self.vault),
            exchange.pool_balance + exchange.total_collateral,
            "vault balance must equal pool_balance + total_collateral"
        );
    }

    fn advance(&mut self, secs: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += secs;
        self.svm.set_sysvar(&clock);
    }
}

fn set_time(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

fn token_program_account(data: Vec<u8>) -> Account {
    Account {
        lamports: 1_000_000_000,
        data,
        owner: spl_token::ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn ix(data: impl InstructionData, accounts: impl ToAccountMetas) -> Instruction {
    Instruction::new_with_bytes(my_defi_dapp::id(), &data.data(), accounts.to_account_metas(None))
}

#[test]
fn long_profit_is_paid_from_pool() {
    let mut env = Env::new();
    let (lp, lp_usdc, lp_lp) = env.user(100_000 * USD);
    env.add_liquidity(&lp, lp_usdc, lp_lp, 100_000 * USD).unwrap();
    assert_eq!(env.balance(lp_lp), 100_000 * USD);

    let (trader, trader_usdc, _) = env.user(1_000 * USD);
    // 10x long: $1,000 collateral, $10,000 size
    env.increase(&trader, trader_usdc, Side::Long, 1_000 * USD, 10_000 * USD, 101 * USD)
        .unwrap();
    env.assert_solvent();

    let position: Position = env.load(env.position_address(trader.pubkey(), Side::Long));
    assert_eq!(position.size_usd, 10_000 * USD);
    assert_eq!(position.collateral, 990 * USD); // minus 0.1% open fee
    assert_eq!(position.entry_price, SOL_PRICE);
    assert_eq!(env.market().long_open_interest, 10_000 * USD);

    // +10% move
    env.set_price(110 * USD);
    env.close(&trader, trader_usdc, Side::Long, 109 * USD).unwrap();
    env.assert_solvent();

    // 990 collateral + 1000 pnl - 10 close fee (no time passed => no borrow fee)
    assert_eq!(env.balance(trader_usdc), 1_980 * USD);
    let exchange = env.exchange();
    assert_eq!(exchange.pool_balance, 100_000 * USD - 980 * USD);
    assert_eq!(exchange.total_open_interest, 0);
    assert_eq!(exchange.total_collateral, 0);
    assert!(env
        .svm
        .get_account(&env.position_address(trader.pubkey(), Side::Long))
        .map_or(true, |a| a.lamports == 0));
}

#[test]
fn short_is_liquidated_after_adverse_move() {
    let mut env = Env::new();
    let (lp, lp_usdc, lp_lp) = env.user(100_000 * USD);
    env.add_liquidity(&lp, lp_usdc, lp_lp, 100_000 * USD).unwrap();

    let (trader, trader_usdc, _) = env.user(500 * USD);
    // 20x short
    env.increase(&trader, trader_usdc, Side::Short, 500 * USD, 10_000 * USD, 99 * USD)
        .unwrap();

    let (keeper, keeper_usdc, _) = env.user(0);
    // Healthy position cannot be liquidated.
    assert!(env
        .liquidate(&keeper, keeper_usdc, trader.pubkey(), trader_usdc, Side::Short)
        .unwrap_err()
        .contains("NotLiquidatable"));

    // +4% move: pnl -400, equity = 490 - 400 - 10 = 80 < 100 maintenance
    env.set_price(104 * USD);
    env.liquidate(&keeper, keeper_usdc, trader.pubkey(), trader_usdc, Side::Short)
        .unwrap();
    env.assert_solvent();

    // reward = min(80, 0.5% of 10k = 50) = 50, owner gets the remaining 30
    assert_eq!(env.balance(keeper_usdc), 50 * USD);
    assert_eq!(env.balance(trader_usdc), 30 * USD);
    assert_eq!(env.market().short_open_interest, 0);
}

#[test]
fn lp_share_price_tracks_trader_pnl_and_fees() {
    let mut env = Env::new();
    let (lp1, lp1_usdc, lp1_lp) = env.user(10_000 * USD);
    env.add_liquidity(&lp1, lp1_usdc, lp1_lp, 10_000 * USD).unwrap();

    let (trader, trader_usdc, _) = env.user(1_000 * USD);
    env.increase(&trader, trader_usdc, Side::Long, 1_000 * USD, 5_000 * USD, u64::MAX)
        .unwrap();
    // Trader loses 10% => $500 unrealized gain for the pool, plus the $5 open fee.
    env.set_price(90 * USD);

    let (lp2, lp2_usdc, lp2_lp) = env.user(10_505 * USD);
    env.add_liquidity(&lp2, lp2_usdc, lp2_lp, 10_505 * USD).unwrap();
    // AUM was 10,505 for 10,000 LP => price 1.0505
    assert_eq!(env.balance(lp2_lp), 10_000 * USD);

    // Borrow fees accrue over time and are charged on close.
    env.advance(3_600 * 10);
    env.set_price(90 * USD);
    env.close(&trader, trader_usdc, Side::Long, 0).unwrap();
    env.assert_solvent();
    // 995 - 500 pnl - 5 close fee - 5 borrow fee (0.01%/h * 10h * 5000)
    assert_eq!(env.balance(trader_usdc), 485 * USD);

    env.remove_liquidity(&lp1, lp1_usdc, lp1_lp, 10_000 * USD).unwrap();
    env.assert_solvent();
    // lp1 gets half the pool: (10,005 + 10,505 + 995 collateral - 485 payout) / 2
    assert_eq!(env.balance(lp1_usdc), 10_510 * USD);
}

#[test]
fn risk_checks_reject_bad_trades() {
    let mut env = Env::new();
    let (lp, lp_usdc, lp_lp) = env.user(10_000 * USD);
    env.add_liquidity(&lp, lp_usdc, lp_lp, 10_000 * USD).unwrap();
    let (trader, trader_usdc, _) = env.user(10_000 * USD);

    let err = env
        .increase(&trader, trader_usdc, Side::Long, 100 * USD, 6_000 * USD, u64::MAX)
        .unwrap_err();
    assert!(err.contains("LeverageTooHigh"), "{err}");

    let err = env
        .increase(&trader, trader_usdc, Side::Long, 100 * USD, 1_000 * USD, 99 * USD)
        .unwrap_err();
    assert!(err.contains("SlippageExceeded"), "{err}");

    // 80% of 10k pool = 8k max open interest
    let err = env
        .increase(&trader, trader_usdc, Side::Short, 1_000 * USD, 9_000 * USD, 0)
        .unwrap_err();
    assert!(err.contains("PoolUtilizationCap"), "{err}");

    env.advance(61);
    let err = env
        .increase(&trader, trader_usdc, Side::Long, 100 * USD, 1_000 * USD, u64::MAX)
        .unwrap_err();
    assert!(err.contains("StalePrice"), "{err}");

    // Only the oracle authority may push prices.
    let err = env
        .send(
            ix(
                my_defi_dapp::instruction::UpdatePrice { price: 1 },
                my_defi_dapp::accounts::UpdatePrice {
                    oracle_authority: trader.pubkey(),
                    market: env.market,
                },
            ),
            &[&trader],
        )
        .unwrap_err();
    assert!(err.contains("InvalidOracleAuthority"), "{err}");

    // LPs cannot withdraw liquidity that backs open interest.
    env.set_price(SOL_PRICE);
    env.increase(&trader, trader_usdc, Side::Long, 1_000 * USD, 7_000 * USD, u64::MAX)
        .unwrap();
    let err = env
        .remove_liquidity(&lp, lp_usdc, lp_lp, 5_000 * USD)
        .unwrap_err();
    assert!(err.contains("PoolUtilizationCap"), "{err}");
}

#[test]
fn partial_close_and_collateral_withdrawal() {
    let mut env = Env::new();
    let (lp, lp_usdc, lp_lp) = env.user(100_000 * USD);
    env.add_liquidity(&lp, lp_usdc, lp_lp, 100_000 * USD).unwrap();
    let (trader, trader_usdc, _) = env.user(1_000 * USD);
    env.increase(&trader, trader_usdc, Side::Long, 1_000 * USD, 10_000 * USD, u64::MAX)
        .unwrap();

    // +10%: close half, withdrawing half the collateral. Realized: 500 pnl - 5 close fee.
    env.set_price(110 * USD);
    env.decrease(&trader, trader_usdc, Side::Long, 5_000 * USD, 495 * USD, 109 * USD)
        .unwrap();
    env.assert_solvent();
    assert_eq!(env.balance(trader_usdc), 990 * USD);
    let position: Position = env.load(env.position_address(trader.pubkey(), Side::Long));
    assert_eq!(position.size_usd, 5_000 * USD);
    assert_eq!(position.collateral, 495 * USD);
    assert_eq!(position.entry_price, SOL_PRICE);
    assert_eq!(env.market().long_open_interest, 5_000 * USD);
    assert_eq!(env.exchange().pool_balance, 100_000 * USD + 10 * USD - 495 * USD);

    // Withdraw collateral only.
    env.decrease(&trader, trader_usdc, Side::Long, 0, 100 * USD, 0).unwrap();
    env.assert_solvent();
    assert_eq!(env.balance(trader_usdc), 1_090 * USD);

    let err = env
        .decrease(&trader, trader_usdc, Side::Long, 0, 390 * USD, 0)
        .unwrap_err();
    assert!(err.contains("CollateralTooSmall"), "{err}");
    let err = env
        .decrease(&trader, trader_usdc, Side::Long, 5_000 * USD, 0, 0)
        .unwrap_err();
    assert!(err.contains("UseClosePosition"), "{err}");
}

#[test]
fn take_profit_and_stop_loss_orders() {
    let mut env = Env::new();
    let (lp, lp_usdc, lp_lp) = env.user(100_000 * USD);
    env.add_liquidity(&lp, lp_usdc, lp_lp, 100_000 * USD).unwrap();
    let (trader, trader_usdc, _) = env.user(1_000 * USD);
    let (keeper, _, _) = env.user(0);
    env.increase(&trader, trader_usdc, Side::Long, 1_000 * USD, 10_000 * USD, u64::MAX)
        .unwrap();

    env.place_order(&trader, trader_usdc, 1, Side::Long, OrderKind::TakeProfit, 110 * USD, 0, 0)
        .unwrap();
    env.place_order(&trader, trader_usdc, 2, Side::Long, OrderKind::StopLoss, 98 * USD, 4_000 * USD, 0)
        .unwrap();
    let err = env
        .place_order(&trader, trader_usdc, 3, Side::Long, OrderKind::StopLoss, 98 * USD, 0, 5 * USD)
        .unwrap_err();
    assert!(err.contains("InvalidOrder"), "{err}");

    env.set_price(105 * USD);
    for id in [1, 2] {
        let err = env
            .execute_trigger(&keeper, trader.pubkey(), trader_usdc, id, Side::Long)
            .unwrap_err();
        assert!(err.contains("OrderNotTriggered"), "{err}");
    }

    // Stop-loss closes 40%: pnl -80, fee 4; 396 of collateral is returned, losses stay with the position.
    env.set_price(98 * USD);
    env.execute_trigger(&keeper, trader.pubkey(), trader_usdc, 2, Side::Long)
        .unwrap();
    env.assert_solvent();
    assert_eq!(env.balance(trader_usdc), 396 * USD);
    assert!(env.is_closed(env.order_address(trader.pubkey(), 2)));
    let position: Position = env.load(env.position_address(trader.pubkey(), Side::Long));
    assert_eq!(position.size_usd, 6_000 * USD);
    assert_eq!(position.collateral, 510 * USD);

    // Take-profit closes the rest: 510 + 600 pnl - 6 fee.
    env.set_price(110 * USD);
    env.execute_trigger(&keeper, trader.pubkey(), trader_usdc, 1, Side::Long)
        .unwrap();
    env.assert_solvent();
    assert_eq!(env.balance(trader_usdc), 1_500 * USD);
    assert!(env.is_closed(env.position_address(trader.pubkey(), Side::Long)));
    assert!(env.is_closed(env.order_address(trader.pubkey(), 1)));
    assert_eq!(env.exchange().total_open_interest, 0);
    assert_eq!(env.exchange().total_collateral, 0);
}

#[test]
fn limit_orders_escrow_fill_and_cancel() {
    let mut env = Env::new();
    let (lp, lp_usdc, lp_lp) = env.user(100_000 * USD);
    env.add_liquidity(&lp, lp_usdc, lp_lp, 100_000 * USD).unwrap();
    let (trader, trader_usdc, _) = env.user(1_000 * USD);
    let (keeper, _, _) = env.user(0);

    let err = env
        .place_order(&trader, trader_usdc, 6, Side::Long, OrderKind::Limit, 95 * USD, 60_000 * USD, 100 * USD)
        .unwrap_err();
    assert!(err.contains("LeverageTooHigh"), "{err}");

    env.place_order(&trader, trader_usdc, 7, Side::Long, OrderKind::Limit, 95 * USD, 5_000 * USD, 500 * USD)
        .unwrap();
    env.assert_solvent();
    assert_eq!(env.balance(trader_usdc), 500 * USD);
    assert_eq!(env.exchange().total_collateral, 500 * USD);

    let err = env
        .execute_limit(&keeper, trader.pubkey(), 7, Side::Long)
        .unwrap_err();
    assert!(err.contains("OrderNotTriggered"), "{err}");

    env.set_price(95 * USD);
    env.execute_limit(&keeper, trader.pubkey(), 7, Side::Long)
        .unwrap();
    env.assert_solvent();
    let position: Position = env.load(env.position_address(trader.pubkey(), Side::Long));
    assert_eq!(position.owner, trader.pubkey());
    assert_eq!(position.size_usd, 5_000 * USD);
    assert_eq!(position.collateral, 495 * USD);
    assert_eq!(position.entry_price, 95 * USD);
    assert!(env.is_closed(env.order_address(trader.pubkey(), 7)));

    env.place_order(&trader, trader_usdc, 8, Side::Short, OrderKind::Limit, 120 * USD, 1_000 * USD, 200 * USD)
        .unwrap();
    assert_eq!(env.balance(trader_usdc), 300 * USD);
    env.cancel_order(&trader, trader_usdc, 8).unwrap();
    env.assert_solvent();
    assert_eq!(env.balance(trader_usdc), 500 * USD);
    assert!(env.is_closed(env.order_address(trader.pubkey(), 8)));
}

// ---------------------------------------------------------------- prediction markets

struct Prediction {
    market: Pubkey,
    vault: Pubkey,
}

impl Env {
    fn create_prediction(
        &mut self,
        id: u64,
        oracle: bool,
        strike: u64,
        close_time: i64,
        liquidity: u64,
        initial_yes_bps: u16,
        fee_bps: u16,
    ) -> Prediction {
        let pid = my_defi_dapp::id();
        let market = Pubkey::find_program_address(&[PREDICTION_SEED, &id.to_le_bytes()], &pid).0;
        let vault = Pubkey::find_program_address(&[PREDICTION_VAULT_SEED, market.as_ref()], &pid).0;
        let admin = self.admin.insecure_clone();
        let admin_usdc = self.token_account(self.usdc, admin.pubkey(), liquidity);
        self.send(
            ix(
                my_defi_dapp::instruction::CreatePrediction {
                    id,
                    question: "Will it happen?".into(),
                    strike,
                    close_time,
                    liquidity,
                    initial_yes_bps,
                    fee_bps,
                },
                my_defi_dapp::accounts::CreatePrediction {
                    admin: admin.pubkey(),
                    exchange: self.exchange,
                    oracle_market: oracle.then_some(self.market),
                    prediction: market,
                    collateral_mint: self.usdc,
                    vault,
                    admin_collateral: admin_usdc,
                    token_program: spl_token::ID,
                    system_program: system_program::ID,
                },
            ),
            &[&admin],
        )
        .unwrap();
        Prediction { market, vault }
    }

    fn prediction_position(&self, p: &Prediction, owner: Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[PREDICTION_POSITION_SEED, p.market.as_ref(), owner.as_ref()],
            &my_defi_dapp::id(),
        )
        .0
    }

    fn buy_shares(&mut self, p: &Prediction, trader: &Keypair, usdc: Pubkey, outcome: Outcome, amount: u64) -> Result<(), String> {
        let position = self.prediction_position(p, trader.pubkey());
        self.send(
            ix(
                my_defi_dapp::instruction::BuyShares { outcome, amount, min_shares_out: 0 },
                my_defi_dapp::accounts::BuyShares {
                    trader: trader.pubkey(),
                    exchange: self.exchange,
                    prediction: p.market,
                    vault: p.vault,
                    position,
                    user_collateral: usdc,
                    token_program: spl_token::ID,
                    system_program: system_program::ID,
                },
            ),
            &[trader],
        )
    }

    fn sell_shares(&mut self, p: &Prediction, trader: &Keypair, usdc: Pubkey, outcome: Outcome, shares: u64) -> Result<(), String> {
        let position = self.prediction_position(p, trader.pubkey());
        self.send(
            ix(
                my_defi_dapp::instruction::SellShares { outcome, shares, min_amount_out: 0 },
                my_defi_dapp::accounts::SellShares {
                    trader: trader.pubkey(),
                    exchange: self.exchange,
                    prediction: p.market,
                    vault: p.vault,
                    position,
                    user_collateral: usdc,
                    token_program: spl_token::ID,
                },
            ),
            &[trader],
        )
    }

    fn resolve_prediction(&mut self, p: &Prediction, signer: &Keypair, outcome: Outcome) -> Result<(), String> {
        self.send(
            ix(
                my_defi_dapp::instruction::ResolvePrediction { outcome },
                my_defi_dapp::accounts::ResolvePrediction {
                    admin: signer.pubkey(),
                    exchange: self.exchange,
                    prediction: p.market,
                },
            ),
            &[signer],
        )
    }

    fn resolve_price_market(&mut self, p: &Prediction, payer: &Keypair) -> Result<(), String> {
        self.send(
            ix(
                my_defi_dapp::instruction::ResolvePriceMarket {},
                my_defi_dapp::accounts::ResolvePriceMarket {
                    exchange: self.exchange,
                    prediction: p.market,
                    oracle_market: self.market,
                },
            ),
            &[payer],
        )
    }

    fn redeem(&mut self, p: &Prediction, owner: &Keypair, usdc: Pubkey) -> Result<(), String> {
        let position = self.prediction_position(p, owner.pubkey());
        self.send(
            ix(
                my_defi_dapp::instruction::RedeemShares {},
                my_defi_dapp::accounts::RedeemShares {
                    owner: owner.pubkey(),
                    exchange: self.exchange,
                    prediction: p.market,
                    vault: p.vault,
                    position,
                    user_collateral: usdc,
                    token_program: spl_token::ID,
                },
            ),
            &[owner],
        )
    }

    fn withdraw_prediction_liquidity(&mut self, p: &Prediction, usdc: Pubkey) -> Result<(), String> {
        let admin = self.admin.insecure_clone();
        self.send(
            ix(
                my_defi_dapp::instruction::WithdrawPredictionLiquidity {},
                my_defi_dapp::accounts::WithdrawPredictionLiquidity {
                    creator: admin.pubkey(),
                    exchange: self.exchange,
                    prediction: p.market,
                    vault: p.vault,
                    creator_collateral: usdc,
                    token_program: spl_token::ID,
                },
            ),
            &[&admin],
        )
    }

    /// Every share is backed: vault == complete sets outstanding + uncollected fees.
    fn assert_prediction_backed(&self, p: &Prediction) {
        let m: PredictionMarket = self.load(p.market);
        assert_eq!(self.balance(p.vault), m.total_sets + m.fees);
    }
}

#[test]
fn custom_prediction_trade_resolve_and_redeem() {
    let mut env = Env::new();
    let now = 1_700_000_000;
    let p = env.create_prediction(1, false, 0, now + 3_600, 1_000 * USD, 5_000, 100);
    let m: PredictionMarket = env.load(p.market);
    assert_eq!(m.yes_price_bps(), 5_000);

    let (alice, alice_usdc, _) = env.user(1_000 * USD);
    let (bob, bob_usdc, _) = env.user(1_000 * USD);
    env.buy_shares(&p, &alice, alice_usdc, Outcome::Yes, 100 * USD).unwrap();
    let after_buy: PredictionMarket = env.load(p.market);
    assert!(after_buy.yes_price_bps() > 5_000, "buying YES raises its price");
    let alice_pos: PredictionPosition = env.load(env.prediction_position(&p, alice.pubkey()));
    // 99 USDC after the 1% fee buys more than 99 shares below $1 each.
    assert!(alice_pos.yes_shares > 99 * USD && alice_pos.no_shares == 0);
    env.assert_prediction_backed(&p);

    env.buy_shares(&p, &bob, bob_usdc, Outcome::No, 50 * USD).unwrap();
    assert!(env.load::<PredictionMarket>(p.market).yes_price_bps() < after_buy.yes_price_bps());
    assert!(env.buy_shares(&p, &bob, bob_usdc, Outcome::Invalid, USD).is_err());

    // Sell half of Alice's YES back.
    let half = alice_pos.yes_shares / 2;
    let before = env.balance(alice_usdc);
    env.sell_shares(&p, &alice, alice_usdc, Outcome::Yes, half).unwrap();
    let received = env.balance(alice_usdc) - before;
    assert!(received > 40 * USD && received < half, "sold below $1 per share: {received}");
    assert!(env.sell_shares(&p, &alice, alice_usdc, Outcome::Yes, alice_pos.yes_shares).is_err());
    env.assert_prediction_backed(&p);

    // Only the admin resolves, and trading stops once it does.
    let bob_clone = bob.insecure_clone();
    assert!(env.resolve_prediction(&p, &bob_clone, Outcome::No).is_err());
    let admin = env.admin.insecure_clone();
    assert!(env.redeem(&p, &alice, alice_usdc).is_err(), "not resolved yet");
    env.resolve_prediction(&p, &admin, Outcome::Yes).unwrap();
    assert!(env.resolve_prediction(&p, &admin, Outcome::No).is_err());
    assert!(env.buy_shares(&p, &bob, bob_usdc, Outcome::No, USD).is_err());

    let remaining = alice_pos.yes_shares - half;
    let before = env.balance(alice_usdc);
    env.redeem(&p, &alice, alice_usdc).unwrap();
    assert_eq!(env.balance(alice_usdc) - before, remaining);
    let before = env.balance(bob_usdc);
    env.redeem(&p, &bob, bob_usdc).unwrap();
    assert_eq!(env.balance(bob_usdc), before, "losing shares pay nothing");
    assert!(env.svm.get_account(&env.prediction_position(&p, bob.pubkey())).map_or(true, |a| a.lamports == 0));

    let admin_usdc = env.token_account(env.usdc, admin.pubkey(), 0);
    env.withdraw_prediction_liquidity(&p, admin_usdc).unwrap();
    assert_eq!(env.balance(p.vault), 0, "every dollar is paid out");
    assert!(env.balance(admin_usdc) > 0);
}

#[test]
fn price_prediction_resolves_from_oracle() {
    let mut env = Env::new();
    let now = 1_700_000_000;
    let close = now + 600;
    let p = env.create_prediction(7, true, 105 * USD, close, 2_000 * USD, 3_000, 0);
    let m: PredictionMarket = env.load(p.market);
    assert!(m.is_price_market());
    assert!((2_999..=3_000).contains(&m.yes_price_bps()));
    assert_eq!(m.yes_reserve, 2_000 * USD);
    assert!(m.creator_yes == 0 && m.creator_no > 0);

    let (alice, alice_usdc, _) = env.user(1_000 * USD);
    env.buy_shares(&p, &alice, alice_usdc, Outcome::Yes, 100 * USD).unwrap();

    // No fee: a round trip cannot make money.
    let (carol, carol_usdc, _) = env.user(1_000 * USD);
    env.buy_shares(&p, &carol, carol_usdc, Outcome::No, 300 * USD).unwrap();
    let pos: PredictionPosition = env.load(env.prediction_position(&p, carol.pubkey()));
    env.sell_shares(&p, &carol, carol_usdc, Outcome::No, pos.no_shares).unwrap();
    assert!(env.balance(carol_usdc) <= 1_000 * USD);
    env.assert_prediction_backed(&p);

    let anyone = Keypair::new();
    env.svm.airdrop(&anyone.pubkey(), 1_000_000_000).unwrap();
    assert!(env.resolve_price_market(&p, &anyone).is_err(), "too early");

    set_time(&mut env.svm, close + 1);
    assert!(env.buy_shares(&p, &alice, alice_usdc, Outcome::Yes, USD).is_err(), "closed");
    assert!(env.resolve_price_market(&p, &anyone).is_err(), "needs a price from after close");
    let admin = env.admin.insecure_clone();
    assert!(env.resolve_prediction(&p, &admin, Outcome::Yes).is_err(), "admin may only void price markets");

    env.set_price(110 * USD);
    env.resolve_price_market(&p, &anyone).unwrap();
    let m: PredictionMarket = env.load(p.market);
    assert!(m.resolved && m.outcome == Outcome::Yes && m.resolved_price == 110 * USD);

    let pos: PredictionPosition = env.load(env.prediction_position(&p, alice.pubkey()));
    let before = env.balance(alice_usdc);
    env.redeem(&p, &alice, alice_usdc).unwrap();
    assert_eq!(env.balance(alice_usdc) - before, pos.yes_shares);
    assert!(pos.yes_shares > 300 * USD, "bought YES at ~30c");
    env.redeem(&p, &carol, carol_usdc).unwrap();

    let admin_usdc = env.token_account(env.usdc, admin.pubkey(), 0);
    env.withdraw_prediction_liquidity(&p, admin_usdc).unwrap();
    assert_eq!(env.balance(p.vault), 0);
}

#[test]
fn invalid_prediction_refunds_half_per_share() {
    let mut env = Env::new();
    let p = env.create_prediction(3, false, 0, 1_700_000_000 + 60, 500 * USD, 6_500, 50);
    let (alice, alice_usdc, _) = env.user(100 * USD);
    env.buy_shares(&p, &alice, alice_usdc, Outcome::No, 100 * USD).unwrap();
    let pos: PredictionPosition = env.load(env.prediction_position(&p, alice.pubkey()));
    let admin = env.admin.insecure_clone();
    env.resolve_prediction(&p, &admin, Outcome::Invalid).unwrap();
    env.redeem(&p, &alice, alice_usdc).unwrap();
    assert_eq!(env.balance(alice_usdc), pos.no_shares / 2);
    let admin_usdc = env.token_account(env.usdc, admin.pubkey(), 0);
    env.withdraw_prediction_liquidity(&p, admin_usdc).unwrap();
    // Halving rounds down, so at most a few base units can be left behind.
    assert!(env.balance(p.vault) <= 2);
}
