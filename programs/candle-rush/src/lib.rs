//! Candle Rush: call the next SOL/USD move in 10-second rounds on a MagicBlock Ephemeral Rollup.
//!
//! Every third correct call in a row earns a "loot candle". Opening it asks MagicBlock VRF for
//! randomness, and the callback drops one of six cards. Longer streaks roll rarer cards. Some cards
//! are perks (a shield that saves a streak, a boost that multiplies the next win's points), others
//! pay points straight away.
//!
//! All players share one zero-copy Arena account. The game's developer creates and delegates it
//! once, so players never need SOL: Ephemeral Rollup transactions are free and a fresh browser
//! wallet can play straight away.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    anchor::{commit, delegate, ephemeral, vrf, vrf_callback},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
    vrf::{
        instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
};

declare_id!("HR8gLWnhgJuMMwGdv5UcyWHRHxifpKzwk1shMDGgQwJN");

pub const ARENA_SEED: &[u8] = b"arena-v1";
pub const MAX_PLAYERS: usize = 64;
pub const ROUND_SECS: i64 = 10;
pub const MAX_PRICE_AGE_SECS: i64 = 120;
/// A seat idle this long can be given to a new player when the arena is full.
pub const IDLE_SECS: i64 = 15 * 60;
pub const LOOT_EVERY: u16 = 3;
pub const BASE_POINTS: u64 = 100;
pub const MAX_MULTIPLIER: u64 = 10;
pub const CARD_KINDS: usize = 6;

/// MagicBlock's SOL/USD price feed on the devnet Ephemeral Rollup (PriceUpdateV2 layout).
pub const SOL_USD_FEED: Pubkey = pubkey!("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
const EPHEMERAL_ORACLE_DISCRIMINATOR: [u8; 8] = [234, 161, 14, 36, 172, 239, 15, 232];
const PYTH_PRICE_UPDATE_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

pub const DIR_UP: u8 = 1;
pub const DIR_DOWN: u8 = 2;

pub const RESULT_WIN: u8 = 1;
pub const RESULT_LOSS: u8 = 2;
pub const RESULT_TIE: u8 = 3;
pub const RESULT_SAVED: u8 = 4;

/// Cards, from common to legendary.
pub const CARD_GREEN_CANDLE: u8 = 0; // boost x2 on the next win
pub const CARD_BAG_HOLDER: u8 = 1; // shield: one wrong call keeps the streak
pub const CARD_DIAMOND_HANDS: u8 = 2; // two shields
pub const CARD_WHALE_ALERT: u8 = 3; // boost x3 on the next win
pub const CARD_PHOENIX: u8 = 4; // +500 points
pub const CARD_SATOSHI: u8 = 5; // +2000 points
pub const NO_CARD: u8 = 255;

#[ephemeral]
#[program]
pub mod candle_rush {
    use super::*;

    /// Base layer, once: creates the shared arena. The signer becomes its authority.
    pub fn init_arena(ctx: Context<InitArena>) -> Result<()> {
        let mut arena = ctx.accounts.arena.load_init()?;
        arena.authority = ctx.accounts.authority.key();
        arena.round_secs = ROUND_SECS;
        Ok(())
    }

    /// Base layer, once: hands the arena to the Ephemeral Rollup.
    pub fn delegate_arena(ctx: Context<DelegateArena>) -> Result<()> {
        ctx.accounts.delegate_arena(
            &ctx.accounts.payer,
            &[ARENA_SEED],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Ephemeral Rollup: takes a seat (no-op if the player already has one). When the arena is
    /// full, the seat idle the longest (at least 15 minutes) goes to the newcomer.
    pub fn join(ctx: Context<Play>) -> Result<()> {
        let mut arena = ctx.accounts.arena.load_mut()?;
        let player = ctx.accounts.player.key();
        if find_slot(&arena, &player).is_ok() {
            return Ok(());
        }
        let now = Clock::get()?.unix_timestamp;
        let seat = match arena.slots.iter().position(|s| s.player == Pubkey::default()) {
            Some(free) => free,
            None => arena
                .slots
                .iter()
                .enumerate()
                .filter(|(_, s)| now - s.last_ts >= IDLE_SECS && s.open == 0 && s.loot_pending == 0)
                .min_by_key(|(_, s)| s.last_ts)
                .map(|(i, _)| i)
                .ok_or(error!(GameError::ArenaFull))?,
        };
        let slot = &mut arena.slots[seat];
        *slot = Slot::default();
        slot.player = player;
        slot.boost = 1;
        slot.last_card = NO_CARD;
        slot.last_ts = now;
        arena.players = arena.players.saturating_add(1);
        Ok(())
    }

    /// Ephemeral Rollup: calls the next move. Snapshots the oracle price as the entry.
    pub fn call(ctx: Context<PlayWithPrice>, direction: u8) -> Result<()> {
        require!(
            direction == DIR_UP || direction == DIR_DOWN,
            GameError::BadDirection
        );
        let (price, publish_time) = read_price(&ctx.accounts.price_feed)?;
        let now = Clock::get()?.unix_timestamp;
        let mut arena = ctx.accounts.arena.load_mut()?;
        let i = find_slot(&arena, &ctx.accounts.player.key())?;
        let slot = &mut arena.slots[i];
        require!(slot.open == 0, GameError::CallAlreadyOpen);
        slot.open = direction;
        slot.entry_price = price;
        slot.entry_publish_time = publish_time;
        slot.entry_ts = now;
        slot.last_ts = now;
        slot.calls = slot.calls.saturating_add(1);
        arena.total_calls = arena.total_calls.saturating_add(1);
        Ok(())
    }

    /// Ephemeral Rollup: settles the open call once the round is over and a newer price exists.
    pub fn settle(ctx: Context<PlayWithPrice>) -> Result<()> {
        let (price, publish_time) = read_price(&ctx.accounts.price_feed)?;
        let now = Clock::get()?.unix_timestamp;
        let mut arena = ctx.accounts.arena.load_mut()?;
        let round_secs = arena.round_secs;
        let i = find_slot(&arena, &ctx.accounts.player.key())?;
        let slot = &mut arena.slots[i];
        require!(slot.open != 0, GameError::NoOpenCall);
        require!(now >= slot.entry_ts + round_secs, GameError::RoundNotOver);
        require!(
            publish_time > slot.entry_publish_time,
            GameError::NoNewPrice
        );

        let moved_up = price > slot.entry_price;
        let moved_down = price < slot.entry_price;
        let won = (slot.open == DIR_UP && moved_up) || (slot.open == DIR_DOWN && moved_down);

        if won {
            slot.streak = slot.streak.saturating_add(1);
            slot.best = slot.best.max(slot.streak);
            slot.wins = slot.wins.saturating_add(1);
            let multiplier = (slot.streak as u64).min(MAX_MULTIPLIER);
            let boost = slot.boost.max(1) as u64;
            slot.points = slot.points.saturating_add(BASE_POINTS * multiplier * boost);
            slot.boost = 1;
            if slot.streak % LOOT_EVERY == 0 {
                slot.loot_ready = slot.loot_ready.saturating_add(1);
            }
            slot.last_result = RESULT_WIN;
        } else if !moved_up && !moved_down {
            slot.last_result = RESULT_TIE;
        } else if slot.shield > 0 {
            slot.shield -= 1;
            slot.last_result = RESULT_SAVED;
        } else {
            slot.streak = 0;
            slot.last_result = RESULT_LOSS;
        }
        slot.last_settle_price = price;
        slot.last_ts = now;
        slot.open = 0;
        Ok(())
    }

    /// Ephemeral Rollup: opens one loot candle by requesting VRF randomness.
    pub fn open_loot(ctx: Context<OpenLoot>, client_seed: u8) -> Result<()> {
        let arena_key = ctx.accounts.arena.key();
        let player = ctx.accounts.player.key();
        let now = Clock::get()?.unix_timestamp;
        let i = {
            let mut arena = ctx.accounts.arena.load_mut()?;
            let i = find_slot(&arena, &player)?;
            let slot = &mut arena.slots[i];
            require!(slot.loot_ready > 0, GameError::NoLoot);
            require!(slot.loot_pending == 0, GameError::LootPending);
            slot.loot_ready -= 1;
            slot.loot_pending = 1;
            slot.last_ts = now;
            i
        };

        let mut seed = [client_seed; 32];
        seed[..8].copy_from_slice(&now.to_le_bytes());
        seed[8..16].copy_from_slice(&player.to_bytes()[..8]);

        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: player,
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::LootCallback::DISCRIMINATOR.to_vec(),
            caller_seed: seed,
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: arena_key,
                is_signer: false,
                is_writable: true,
            }]),
            callback_args: Some(vec![i as u8]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.player.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF callback: turns the randomness into a card. Longer best streaks roll rarer cards.
    pub fn loot_callback(
        ctx: Context<LootCallback>,
        randomness: [u8; 32],
        slot_index: u8,
    ) -> Result<()> {
        let mut arena = ctx.accounts.arena.load_mut()?;
        let i = slot_index as usize;
        require!(i < MAX_PLAYERS, GameError::BadSlot);
        let slot = &mut arena.slots[i];
        require!(slot.loot_pending == 1, GameError::NoLoot);

        let roll = u32::from_le_bytes([randomness[0], randomness[1], randomness[2], randomness[3]])
            % 10_000;
        let bonus = (slot.best.min(15) as u32) * 150;
        let card = card_for_roll((roll + bonus).min(9_999));

        slot.cards[card as usize] = slot.cards[card as usize].saturating_add(1);
        slot.last_card = card;
        slot.loot_pending = 0;
        match card {
            CARD_PHOENIX => slot.points = slot.points.saturating_add(500),
            CARD_SATOSHI => slot.points = slot.points.saturating_add(2_000),
            _ => {}
        }
        Ok(())
    }

    /// Ephemeral Rollup: plays a perk card from the player's hand.
    pub fn use_card(ctx: Context<Play>, card: u8) -> Result<()> {
        let mut arena = ctx.accounts.arena.load_mut()?;
        let i = find_slot(&arena, &ctx.accounts.player.key())?;
        let slot = &mut arena.slots[i];
        let idx = card as usize;
        require!(idx < CARD_KINDS, GameError::BadCard);
        require!(slot.cards[idx] > 0, GameError::NoSuchCard);
        match card {
            CARD_GREEN_CANDLE => slot.boost = slot.boost.max(2),
            CARD_WHALE_ALERT => slot.boost = slot.boost.max(3),
            CARD_BAG_HOLDER => slot.shield = slot.shield.saturating_add(1),
            CARD_DIAMOND_HANDS => slot.shield = slot.shield.saturating_add(2),
            _ => return err!(GameError::NotAPerk),
        }
        slot.cards[idx] -= 1;
        Ok(())
    }

    /// Ephemeral Rollup: anyone can checkpoint the arena to Solana.
    pub fn commit_arena(ctx: Context<CommitArena>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.arena.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Ephemeral Rollup, authority only: commits and returns the arena to Solana.
    pub fn undelegate_arena(ctx: Context<CommitArena>) -> Result<()> {
        let authority = ctx.accounts.arena.load()?.authority;
        require_keys_eq!(
            ctx.accounts.payer.key(),
            authority,
            GameError::NotAuthority
        );
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.arena.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

fn find_slot(arena: &Arena, player: &Pubkey) -> Result<usize> {
    arena
        .slots
        .iter()
        .position(|s| s.player == *player)
        .ok_or(error!(GameError::NotJoined))
}

/// Reads price and publish time from the SOL/USD feed and rejects stale data.
fn read_price(feed: &UncheckedAccount) -> Result<(i64, i64)> {
    require_keys_eq!(feed.key(), SOL_USD_FEED, GameError::WrongFeed);
    let data = feed.try_borrow_data()?;
    require!(data.len() >= 133, GameError::BadFeed);
    let discriminator: [u8; 8] = data[0..8].try_into().unwrap();
    require!(
        discriminator == EPHEMERAL_ORACLE_DISCRIMINATOR
            || discriminator == PYTH_PRICE_UPDATE_DISCRIMINATOR,
        GameError::BadFeed
    );
    let price = i64::from_le_bytes(data[73..81].try_into().unwrap());
    let publish_time = i64::from_le_bytes(data[93..101].try_into().unwrap());
    let now = Clock::get()?.unix_timestamp;
    require!(
        now - publish_time <= MAX_PRICE_AGE_SECS,
        GameError::StalePrice
    );
    Ok((price, publish_time))
}

/// Maps a roll in 0..10000 to a card: 45% / 25% / 15% / 10% / 4% / 1% before the streak bonus.
pub fn card_for_roll(roll: u32) -> u8 {
    match roll {
        0..=4_499 => CARD_GREEN_CANDLE,
        4_500..=6_999 => CARD_BAG_HOLDER,
        7_000..=8_499 => CARD_DIAMOND_HANDS,
        8_500..=9_499 => CARD_WHALE_ALERT,
        9_500..=9_899 => CARD_PHOENIX,
        _ => CARD_SATOSHI,
    }
}

/// One player's seat. Fields are ordered so the C layout has no hidden padding (112 bytes).
#[zero_copy]
#[derive(Default)]
pub struct Slot {
    pub player: Pubkey,
    pub points: u64,
    pub entry_price: i64,
    pub entry_publish_time: i64,
    pub entry_ts: i64,
    pub last_settle_price: i64,
    pub last_ts: i64,
    pub calls: u32,
    pub wins: u32,
    pub streak: u16,
    pub best: u16,
    /// 0 = no open call, 1 = up, 2 = down.
    pub open: u8,
    pub last_result: u8,
    pub loot_ready: u8,
    pub loot_pending: u8,
    pub last_card: u8,
    /// Points multiplier for the next win (1 = none).
    pub boost: u8,
    pub shield: u8,
    pub cards: [u8; CARD_KINDS],
    pub padding: [u8; 7],
}

#[account(zero_copy)]
pub struct Arena {
    pub authority: Pubkey,
    pub round_secs: i64,
    pub total_calls: u64,
    pub players: u16,
    pub padding: [u8; 6],
    pub slots: [Slot; MAX_PLAYERS],
}

#[derive(Accounts)]
pub struct InitArena<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<Arena>(),
        seeds = [ARENA_SEED],
        bump
    )]
    pub arena: AccountLoader<'info, Arena>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateArena<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the arena PDA to delegate
    #[account(mut, del, seeds = [ARENA_SEED], bump)]
    pub arena: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Play<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [ARENA_SEED], bump)]
    pub arena: AccountLoader<'info, Arena>,
}

#[derive(Accounts)]
pub struct PlayWithPrice<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [ARENA_SEED], bump)]
    pub arena: AccountLoader<'info, Arena>,
    /// CHECK: address and layout are checked in read_price
    pub price_feed: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct OpenLoot<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [ARENA_SEED], bump)]
    pub arena: AccountLoader<'info, Arena>,
    /// CHECK: validated by the ephemeral VRF program when it processes the request
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct LootCallback<'info> {
    #[account(mut, seeds = [ARENA_SEED], bump)]
    pub arena: AccountLoader<'info, Arena>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitArena<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ARENA_SEED], bump)]
    pub arena: AccountLoader<'info, Arena>,
}

#[error_code]
pub enum GameError {
    #[msg("The arena is full")]
    ArenaFull,
    #[msg("Join the arena first")]
    NotJoined,
    #[msg("Direction must be 1 (up) or 2 (down)")]
    BadDirection,
    #[msg("You already have an open call")]
    CallAlreadyOpen,
    #[msg("No open call to settle")]
    NoOpenCall,
    #[msg("The round is not over yet")]
    RoundNotOver,
    #[msg("Waiting for a newer oracle price")]
    NoNewPrice,
    #[msg("Wrong price feed")]
    WrongFeed,
    #[msg("Price feed data is not recognized")]
    BadFeed,
    #[msg("Oracle price is too old")]
    StalePrice,
    #[msg("No loot candle to open")]
    NoLoot,
    #[msg("A loot candle is already opening")]
    LootPending,
    #[msg("Bad slot index")]
    BadSlot,
    #[msg("Unknown card")]
    BadCard,
    #[msg("You don't have that card")]
    NoSuchCard,
    #[msg("That card pays out on its own and can't be played")]
    NotAPerk,
    #[msg("Only the arena authority can do this")]
    NotAuthority,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_odds_match_the_table() {
        let mut counts = [0u32; CARD_KINDS];
        for roll in 0..10_000 {
            counts[card_for_roll(roll) as usize] += 1;
        }
        assert_eq!(counts, [4_500, 2_500, 1_500, 1_000, 400, 100]);
    }

    #[test]
    fn streak_bonus_pushes_rolls_toward_rare_cards() {
        let bonus = 15 * 150;
        assert_eq!(card_for_roll(0), CARD_GREEN_CANDLE);
        assert_eq!(card_for_roll(bonus), CARD_GREEN_CANDLE);
        assert_eq!(card_for_roll((9_000 + bonus).min(9_999)), CARD_SATOSHI);
        assert_eq!(card_for_roll(9_999), CARD_SATOSHI);
    }

    #[test]
    fn layout_has_no_hidden_padding_and_fits_one_account() {
        assert_eq!(std::mem::size_of::<Slot>(), 112);
        assert_eq!(std::mem::size_of::<Arena>(), 56 + 112 * MAX_PLAYERS);
        // An account created by a program instruction can be at most 10 KiB.
        assert!(8 + std::mem::size_of::<Arena>() <= 10_240);
    }
}
