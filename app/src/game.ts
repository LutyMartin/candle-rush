import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import idl from "./idl/candle_rush.json";

export const ER_ENDPOINT =
  import.meta.env.VITE_ER_ENDPOINT ?? "https://devnet-as.magicblock.app";
export const ER_WS_ENDPOINT =
  import.meta.env.VITE_ER_WS_ENDPOINT ?? "wss://devnet-as.magicblock.app";
export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
export const SOL_USD_FEED = new PublicKey(
  "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu",
);
export const ARENA = PublicKey.findProgramAddressSync(
  [Buffer.from("arena-v1")],
  PROGRAM_ID,
)[0];
export const ROUND_SECS = 10;
export const LOOT_EVERY = 3;

const WALLET_KEY = "candleRushWalletV1";

export type Card = {
  id: number;
  name: string;
  rarity: "Common" | "Rare" | "Epic" | "Legendary";
  effect: string;
  perk: boolean;
  glyph: string;
};

export const CARDS: Card[] = [
  { id: 0, name: "Green Candle", rarity: "Common", effect: "Boost: your next win scores x2", perk: true, glyph: "🕯️" },
  { id: 1, name: "Bag Holder", rarity: "Common", effect: "Shield: one wrong call keeps your streak", perk: true, glyph: "🎒" },
  { id: 2, name: "Diamond Hands", rarity: "Rare", effect: "Two shields at once", perk: true, glyph: "💎" },
  { id: 3, name: "Whale Alert", rarity: "Rare", effect: "Boost: your next win scores x3", perk: true, glyph: "🐋" },
  { id: 4, name: "Liquidation Phoenix", rarity: "Epic", effect: "+500 points the moment it drops", perk: false, glyph: "🔥" },
  { id: 5, name: "Satoshi's Candle", rarity: "Legendary", effect: "+2000 points the moment it drops", perk: false, glyph: "₿" },
];

export type Slot = {
  player: string;
  points: number;
  streak: number;
  best: number;
  calls: number;
  wins: number;
  open: number;
  entryPrice: bigint;
  entryTs: number;
  lastSettlePrice: bigint;
  lastResult: number;
  lootReady: number;
  lootPending: number;
  lastCard: number;
  boost: number;
  shield: number;
  cards: number[];
};

export type ArenaState = {
  players: number;
  totalCalls: number;
  slots: Slot[];
};

export type Price = { raw: bigint; expo: number; publishTime: number; value: number };

export function loadWallet(): Keypair {
  const stored = localStorage.getItem(WALLET_KEY);
  if (stored) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
    } catch {
      localStorage.removeItem(WALLET_KEY);
    }
  }
  const kp = Keypair.generate();
  localStorage.setItem(WALLET_KEY, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

class BurnerWallet implements Wallet {
  constructor(readonly payer: Keypair) {}
  get publicKey() {
    return this.payer.publicKey;
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) tx.sign([this.payer]);
    else tx.partialSign(this.payer);
    return tx;
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map((tx) => this.signTransaction(tx)));
  }
}

export class Game {
  readonly connection: Connection;
  readonly program: Program;
  constructor(readonly wallet: Keypair) {
    this.connection = new Connection(ER_ENDPOINT, {
      commitment: "confirmed",
      wsEndpoint: ER_WS_ENDPOINT,
    });
    const provider = new AnchorProvider(this.connection, new BurnerWallet(wallet), {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    this.program = new Program(idl as Idl, provider);
  }

  /** Sends one instruction to the Ephemeral Rollup and returns signature and latency. */
  private async send(tx: Transaction): Promise<{ signature: string; ms: number }> {
    const started = performance.now();
    tx.feePayer = this.wallet.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(this.wallet);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await this.connection.confirmTransaction(signature, "confirmed");
    return { signature, ms: Math.round(performance.now() - started) };
  }

  join() {
    return this.program.methods
      .join()
      .accounts({ player: this.wallet.publicKey })
      .transaction()
      .then((tx) => this.send(tx));
  }

  call(direction: 1 | 2) {
    return this.program.methods
      .call(direction)
      .accounts({ player: this.wallet.publicKey, priceFeed: SOL_USD_FEED })
      .transaction()
      .then((tx) => this.send(tx));
  }

  settle() {
    return this.program.methods
      .settle()
      .accounts({ player: this.wallet.publicKey, priceFeed: SOL_USD_FEED })
      .transaction()
      .then((tx) => this.send(tx));
  }

  openLoot() {
    const seed = Math.floor(Math.random() * 256);
    return this.program.methods
      .openLoot(seed)
      .accounts({ player: this.wallet.publicKey })
      .transaction()
      .then((tx) => this.send(tx));
  }

  useCard(card: number) {
    return this.program.methods
      .useCard(card)
      .accounts({ player: this.wallet.publicKey })
      .transaction()
      .then((tx) => this.send(tx));
  }

  async fetchArena(): Promise<ArenaState | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accounts = this.program.account as any;
    const raw = await accounts.arena.fetchNullable(ARENA);
    if (!raw) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slots: Slot[] = raw.slots.map((s: any) => ({
      player: (s.player as PublicKey).toBase58(),
      points: Number(s.points as BN),
      streak: s.streak,
      best: s.best,
      calls: s.calls,
      wins: s.wins,
      open: s.open,
      entryPrice: BigInt((s.entryPrice as BN).toString()),
      entryTs: Number(s.entryTs as BN),
      lastSettlePrice: BigInt((s.lastSettlePrice as BN).toString()),
      lastResult: s.lastResult,
      lootReady: s.lootReady,
      lootPending: s.lootPending,
      lastCard: s.lastCard,
      boost: s.boost,
      shield: s.shield,
      cards: Array.from(s.cards as number[]),
    }));
    return { players: raw.players, totalCalls: Number(raw.totalCalls as BN), slots };
  }

  async fetchPrice(): Promise<Price | null> {
    const account = await this.connection.getAccountInfo(SOL_USD_FEED, "confirmed");
    if (!account || account.data.length < 133) return null;
    const data = Buffer.from(account.data);
    const raw = data.readBigInt64LE(73);
    const expo = data.readInt32LE(89);
    const publishTime = Number(data.readBigInt64LE(93));
    return { raw, expo, publishTime, value: priceValue(raw, expo) };
  }
}

/** MagicBlock's oracle stores the exponent as a positive scale (8), Pyth as negative (-8). */
export function priceValue(raw: bigint, expo: number) {
  return Number(raw) / 10 ** Math.abs(expo);
}

export function shortKey(key: string) {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Turns an Anchor/RPC error into one readable line. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const match = text.match(/Error Message: ([^.]+)\./);
  if (match) return match[1];
  const logs = (error as { logs?: string[] })?.logs;
  const logLine = logs?.find((line) => line.includes("Error Message:"));
  if (logLine) return logLine.split("Error Message:")[1].trim();
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}
