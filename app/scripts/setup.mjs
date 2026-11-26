// One-time setup by the developer key: create the shared arena on Solana devnet and delegate it
// to a MagicBlock Ephemeral Rollup validator. Players never pay for anything after this.
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";

const idl = JSON.parse(fs.readFileSync(new URL("../src/idl/candle_rush.json", import.meta.url)));
const BASE = process.env.BASE_RPC ?? "https://api.devnet.solana.com";
// devnet-as.magicblock.app validator; must match the ER endpoint the app uses.
const VALIDATOR = new PublicKey(process.env.VALIDATOR ?? "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const keyPath = process.env.KEYPAIR ?? `${os.homedir()}/.config/solana/id.json`;
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8"))));

const connection = new Connection(BASE, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const [arena] = PublicKey.findProgramAddressSync([Buffer.from("arena-v1")], program.programId);
console.log("program", program.programId.toBase58(), "arena", arena.toBase58());

let info = await connection.getAccountInfo(arena);
if (!info) {
  const sig = await program.methods.initArena().accounts({ authority: authority.publicKey }).rpc();
  console.log("init_arena", sig);
  info = await connection.getAccountInfo(arena);
}
if (info.owner.equals(program.programId)) {
  const sig = await program.methods
    .delegateArena()
    .accounts({ payer: authority.publicKey })
    .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
    .rpc();
  console.log("delegate_arena", sig);
} else {
  console.log("arena is already delegated; owner", info.owner.toBase58());
}
