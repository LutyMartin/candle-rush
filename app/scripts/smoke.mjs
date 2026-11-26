// Plays real rounds on the devnet Ephemeral Rollup from a wallet with 0 SOL:
// join, call, wait for the round, settle; opens a loot candle if one is ready.
// KEYPAIR=path reuses a keypair file (or creates it). UNTIL_LOOT=1 stops as soon as a
// loot candle is ready and leaves it unopened.
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";

const idl = JSON.parse(fs.readFileSync(new URL("../src/idl/candle_rush.json", import.meta.url)));
const ER = process.env.ER_RPC ?? "https://devnet-as.magicblock.app";
const FEED = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
const rounds = Number(process.env.ROUNDS ?? 2);
const untilLoot = process.env.UNTIL_LOOT === "1";
const player = loadPlayer(process.env.KEYPAIR);
const connection = new Connection(ER, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(player), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const [arena] = PublicKey.findProgramAddressSync([Buffer.from("arena-v1")], program.programId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlayer(path) {
  if (!path) return Keypair.generate();
  if (fs.existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
  const kp = Keypair.generate();
  fs.writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

async function send(label, builder) {
  const tx = await builder.transaction();
  tx.feePayer = player.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(player);
  const t0 = Date.now();
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`${label}: ${Date.now() - t0} ms ${sig}`);
}
const mine = async () => (await program.account.arena.fetch(arena)).slots.find((s) => s.player.equals(player.publicKey));

console.log("player", player.publicKey.toBase58(), "(0 SOL)");
if (!(await mine())) await send("join", program.methods.join().accounts({ player: player.publicKey }));
for (let i = 0; i < rounds; i++) {
  await send(`call up #${i + 1}`, program.methods.call(1).accounts({ player: player.publicKey, priceFeed: FEED }));
  await sleep(11_000);
  for (let tries = 0; tries < 10; tries++) {
    try {
      await send("settle", program.methods.settle().accounts({ player: player.publicKey, priceFeed: FEED }));
      break;
    } catch (e) {
      console.log("settle retry:", String(e.message ?? e).slice(0, 120));
      await sleep(1500);
    }
  }
  const s = await mine();
  console.log(`  result ${s.lastResult} streak ${s.streak} points ${s.points.toString()} loot ${s.lootReady}`);
  if (s.lootReady > 0) {
    if (untilLoot) {
      console.log("loot candle ready, left unopened");
      break;
    }
    await send("open_loot", program.methods.openLoot(7).accounts({ player: player.publicKey }));
    for (let w = 0; w < 20 && (await mine()).lootPending === 1; w++) await sleep(500);
    console.log("  card", (await mine()).lastCard);
  }
}
