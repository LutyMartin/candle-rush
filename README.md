# 🕯️ Candle Rush

**Call the next SOL move in 10-second rounds. Streaks open loot. Every move is onchain.**

Candle Rush is an Entertainment Finance game built on MagicBlock Ephemeral Rollups. You read a live
SOL/USD price, call UP or DOWN, and the round settles onchain ten seconds later. Right calls build a
streak; every third win in a row drops a loot candle that MagicBlock VRF turns into a card. Cards are
playable perks (shields that save your streak, boosts that multiply your next win) or instant points.

- **Play:** https://lutymartin.github.io/candle-rush/
- **Program (devnet):** `HR8gLWnhgJuMMwGdv5UcyWHRHxifpKzwk1shMDGgQwJN`

No wallet, no SOL, no sign-up: the page makes a burner key in your browser and you play straight away.

## How a round works

1. **Call.** You press UP or DOWN. The `call` instruction runs on the Ephemeral Rollup, reads
   MagicBlock's SOL/USD oracle account there and snapshots the entry price and publish time.
2. **Wait ten seconds.** The page shows the live price against your entry.
3. **Settle.** The page sends `settle`. The program checks that the round is over and that the
   oracle has published a newer price, then scores the call:
   - right call: streak +1, points += 100 × streak (capped at ×10), times any active boost;
   - flat price: nothing changes;
   - wrong call: a shield absorbs it if you have one, otherwise the streak resets.
4. **Loot.** Every third win in a row adds a loot candle. `open_loot` requests randomness from
   MagicBlock VRF; the `loot_callback` turns it into a card. Your best streak shifts the roll toward
   rarer cards.

## Cards

| Card | Rarity | Base odds | Effect |
| --- | --- | --- | --- |
| 🕯️ Green Candle | Common | 45% | Boost: next win scores ×2 |
| 🎒 Bag Holder | Common | 25% | Shield: one wrong call keeps your streak |
| 💎 Diamond Hands | Rare | 15% | Two shields |
| 🐋 Whale Alert | Rare | 10% | Boost: next win scores ×3 |
| 🔥 Liquidation Phoenix | Epic | 4% | +500 points when it drops |
| ₿ Satoshi's Candle | Legendary | 1% | +2000 points when it drops |

The roll is `randomness % 10000`, plus 150 per point of best streak (up to a streak of 15).

## What MagicBlock does here

- **Ephemeral Rollup.** Calls, settles and card plays are zero-fee transactions on a rollup, fast
  enough for ten-second rounds. The page shows each transaction's confirm time.
- **Oracle on the rollup.** MagicBlock's SOL/USD price feed lives on the Ephemeral Rollup, so the
  program reads real prices at entry and at settlement, onchain.
- **VRF.** Loot is provably random. The callback only accepts randomness signed by this program's
  scoped VRF identity.
- **Gasless by design.** One shared `Arena` account holds every player's state. The developer creates
  and delegates it once; after that players sign with a fresh key holding 0 SOL.
- **Back to Solana.** Anyone can checkpoint the arena to the base layer with `commit_arena`.

```text
 Solana devnet (base layer)                    MagicBlock Ephemeral Rollup
 ──────────────────────────                    ───────────────────────────
 init_arena      (developer, once)
 delegate_arena  (developer, once) ──────────▶ Arena account lives here
                                               join / call / settle / use_card   (players, free)
                                               open_loot ──▶ MagicBlock VRF ──▶ loot_callback
                 ◀────────────── commit_arena  (anyone, any time)
```

## Program

| Instruction | Where | Who | What it does |
| --- | --- | --- | --- |
| `init_arena` | Solana | developer | Creates the shared arena (64 seats) |
| `delegate_arena` | Solana | developer | Delegates the arena to an ER validator |
| `join` | ER | player | Takes a free seat, or the seat of a player idle for 15 minutes |
| `call(direction)` | ER | player | Snapshots the oracle price for an UP or DOWN call |
| `settle` | ER | player | Scores the call after the round, against a newer price |
| `open_loot(seed)` | ER | player | Requests VRF randomness for one loot candle |
| `loot_callback` | ER | VRF | Drops a card from the randomness |
| `use_card(card)` | ER | player | Plays a shield or boost |
| `commit_arena` | ER | anyone | Commits the arena to Solana |
| `undelegate_arena` | ER | developer | Commits and returns the arena to Solana |

Source: [`programs/candle-rush/src/lib.rs`](programs/candle-rush/src/lib.rs). The web app is in
[`app/`](app/).

## Run it yourself

Tools: Rust, Solana CLI, Anchor 1.0.2, Node 22. With platform tools v1.52, build with
`cargo-build-sbf --tools-version v1.52 --arch v0` and `anchor idl build` instead of `anchor build`.
Keep the committed `Cargo.lock`: it pins the Solana crates that Anchor 1.0.2 expects.

```bash
anchor build
anchor deploy --provider.cluster devnet
cd app && npm install
node scripts/setup.mjs      # creates and delegates the arena (developer key)
node scripts/smoke.mjs      # plays real rounds from a fresh 0-SOL key
npm run dev
```

The app talks to `https://devnet-as.magicblock.app`. `setup.mjs` delegates to that endpoint's
validator; set `VALIDATOR` and `VITE_ER_ENDPOINT` together to use another one.

Built for MagicBlock Solana Blitz v10 (Entertainment Finance).
