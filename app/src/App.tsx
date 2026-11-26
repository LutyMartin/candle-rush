import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArenaState,
  CARDS,
  errorText,
  Game,
  LOOT_EVERY,
  loadWallet,
  priceValue,
  PROGRAM_ID,
  ROUND_SECS,
  shortKey,
  Slot,
} from "./game";

type Tick = { t: number; v: number };
type LogLine = { id: number; text: string; tone: "ok" | "bad" | "info"; sig?: string; ms?: number };

const EMPTY_KEY = "11111111111111111111111111111111";
const EXPLORER = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent("https://devnet-as.magicblock.app")}`;
const REPO_URL = "https://github.com/LutyMartin/candle-rush";

export default function App() {
  const wallet = useMemo(() => loadWallet(), []);
  const game = useMemo(() => new Game(wallet), [wallet]);
  const me58 = wallet.publicKey.toBase58();

  const [arena, setArena] = useState<ArenaState | null>(null);
  const [arenaMissing, setArenaMissing] = useState(false);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [expo, setExpo] = useState(-8);
  const [now, setNow] = useState(Date.now() / 1000);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [reveal, setReveal] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ text: string; tone: "ok" | "bad" | "info" } | null>(null);
  const settling = useRef(false);
  const prevMe = useRef<Slot | null>(null);
  const logId = useRef(0);

  const me = arena?.slots.find((s) => s.player === me58) ?? null;
  const price = ticks.length ? ticks[ticks.length - 1].v : null;

  const addLog = useCallback((line: Omit<LogLine, "id">) => {
    logId.current += 1;
    setLog((old) => [{ ...line, id: logId.current }, ...old].slice(0, 8));
  }, []);

  // Poll the oracle and the arena on the Ephemeral Rollup.
  useEffect(() => {
    let alive = true;
    const loop = async () => {
      while (alive) {
        try {
          const [p, a] = await Promise.all([game.fetchPrice(), game.fetchArena()]);
          if (!alive) break;
          if (p) {
            setExpo(p.expo);
            setTicks((old) => {
              const last = old[old.length - 1];
              if (last && last.v === p.value && Date.now() / 1000 - last.t < 2) return old;
              return [...old, { t: Date.now() / 1000, v: p.value }].slice(-120);
            });
          }
          setArena(a);
          setArenaMissing(!a);
        } catch {
          // Network hiccup: keep the last good state and try again.
        }
        setNow(Date.now() / 1000);
        await new Promise((r) => setTimeout(r, 700));
      }
    };
    loop();
    return () => {
      alive = false;
    };
  }, [game]);

  // React to settle results and loot reveals.
  useEffect(() => {
    const before = prevMe.current;
    if (me && before) {
      if (before.open !== 0 && me.open === 0) {
        const gained = me.points - before.points;
        if (me.lastResult === 1) setFlash({ text: `+${gained} · streak ${me.streak}`, tone: "ok" });
        else if (me.lastResult === 2) setFlash({ text: "Wrong call · streak reset", tone: "bad" });
        else if (me.lastResult === 3) setFlash({ text: "Flat candle · no change", tone: "info" });
        else if (me.lastResult === 4) setFlash({ text: "Shield saved your streak", tone: "info" });
      }
      if (before.lootPending === 1 && me.lootPending === 0 && me.lastCard < CARDS.length) {
        setReveal(me.lastCard);
      }
    }
    prevMe.current = me;
  }, [me]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  const run = useCallback(
    async (label: string, action: () => Promise<{ signature: string; ms: number }>) => {
      setBusy(label);
      try {
        const { signature, ms } = await action();
        addLog({ text: label, tone: "ok", sig: signature, ms });
        return true;
      } catch (error) {
        addLog({ text: `${label}: ${errorText(error)}`, tone: "bad" });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [addLog],
  );

  const ensureSeat = useCallback(async () => {
    if (me) return true;
    return run("Joined the arena", () => game.join());
  }, [me, run, game]);

  const call = async (direction: 1 | 2) => {
    if (!(await ensureSeat())) return;
    await run(direction === 1 ? "Called UP" : "Called DOWN", () => game.call(direction));
  };

  // Settle automatically once the round is over.
  useEffect(() => {
    if (!me || me.open === 0 || settling.current) return;
    if (now < me.entryTs + ROUND_SECS + 0.5) return;
    settling.current = true;
    game
      .settle()
      .then(({ signature, ms }) => addLog({ text: "Settled", tone: "ok", sig: signature, ms }))
      .catch((error) => {
        const text = errorText(error);
        if (!/newer oracle price|not over/i.test(text)) addLog({ text: `Settle: ${text}`, tone: "bad" });
      })
      .finally(() => {
        setTimeout(() => {
          settling.current = false;
        }, 900);
      });
  }, [me, now, game, addLog]);

  const leaderboard = (arena?.slots ?? [])
    .filter((s) => s.player !== EMPTY_KEY && s.calls > 0)
    .sort((a, b) => b.points - a.points || b.best - a.best)
    .slice(0, 10);

  const open = me?.open ?? 0;
  const remaining = me && open ? Math.max(0, Math.ceil(me.entryTs + ROUND_SECS - now)) : 0;
  const entry = me && open ? priceValue(me.entryPrice, expo) : null;
  const winning =
    entry !== null && price !== null
      ? (open === 1 && price > entry) || (open === 2 && price < entry)
      : null;
  const toLoot = me ? LOOT_EVERY - (me.streak % LOOT_EVERY) : LOOT_EVERY;

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>
            CANDLE <span>RUSH</span>
          </h1>
          <p className="tag">Call the next SOL move. Streaks open loot. Every move is onchain.</p>
        </div>
        <div className="chips">
          <span className="chip">🔑 {shortKey(me58)}</span>
          <span className="chip live">● Ephemeral Rollup · devnet</span>
        </div>
      </header>

      {arenaMissing && (
        <div className="notice">The arena isn't open on the Ephemeral Rollup yet. Try again in a minute.</div>
      )}

      <main className="grid">
        <section className="card chart-card">
          <div className="price-row">
            <div>
              <div className="label">SOL / USD · MagicBlock oracle</div>
              <div className="price">{price !== null ? `$${price.toFixed(3)}` : "…"}</div>
            </div>
            {open !== 0 && entry !== null && (
              <div className={`round ${winning ? "win" : winning === false ? "lose" : ""}`}>
                <div className="label">
                  {open === 1 ? "▲ UP" : "▼ DOWN"} from ${entry.toFixed(3)}
                </div>
                <div className="count">{remaining > 0 ? `${remaining}s` : "settling…"}</div>
              </div>
            )}
          </div>
          <Chart ticks={ticks} entry={entry} />
          <div className="buttons">
            <button className="up" disabled={!!busy || open !== 0 || arenaMissing} onClick={() => call(1)}>
              ▲ UP
            </button>
            <button className="down" disabled={!!busy || open !== 0 || arenaMissing} onClick={() => call(2)}>
              ▼ DOWN
            </button>
          </div>
          <p className="hint">
            Each round lasts {ROUND_SECS}s. A right call adds 100 × your streak (up to ×10). Every {LOOT_EVERY} wins in a
            row earn a loot candle.
          </p>
          {flash && <div className={`flash ${flash.tone}`}>{flash.text}</div>}
        </section>

        <section className="card stats">
          <Stat label="Streak" value={me ? `🔥 ${me.streak}` : "–"} sub={me ? `×${Math.min(Math.max(me.streak, 1), 10)} next win` : ""} />
          <Stat label="Points" value={me ? me.points.toLocaleString() : "–"} sub={me ? `best streak ${me.best}` : ""} />
          <Stat label="Accuracy" value={me && me.calls ? `${Math.round((me.wins / me.calls) * 100)}%` : "–"} sub={me ? `${me.wins}/${me.calls} calls` : ""} />
          <div className="pips">
            {Array.from({ length: LOOT_EVERY }, (_, i) => (
              <span key={i} className={me && i < LOOT_EVERY - toLoot ? "pip on" : "pip"} />
            ))}
            <span className="pips-text">{toLoot} win{toLoot === 1 ? "" : "s"} to the next loot candle</span>
          </div>
          <div className="buffs">
            {me && me.boost > 1 && <span className="buff">⚡ Boost ×{me.boost}</span>}
            {me && me.shield > 0 && <span className="buff">🛡️ Shield ×{me.shield}</span>}
          </div>
          <button
            className="loot"
            disabled={!me || me.lootReady === 0 || me.lootPending === 1 || !!busy}
            onClick={() => run("Opened a loot candle (VRF)", () => game.openLoot())}
          >
            {me?.lootPending ? "🎲 VRF is rolling…" : `🕯️ Open loot candle${me?.lootReady ? ` (${me.lootReady})` : ""}`}
          </button>
        </section>

        <section className="card hand">
          <h2>Your hand</h2>
          <div className="cards">
            {CARDS.map((c) => (
              <div key={c.id} className={`playing ${c.rarity.toLowerCase()} ${me && me.cards[c.id] ? "" : "dim"}`}>
                <div className="glyph">{c.glyph}</div>
                <div className="name">{c.name}</div>
                <div className="rarity">{c.rarity}</div>
                <div className="effect">{c.effect}</div>
                <div className="count-badge">×{me ? me.cards[c.id] : 0}</div>
                {c.perk && (
                  <button
                    disabled={!me || !me.cards[c.id] || !!busy}
                    onClick={() => run(`Played ${c.name}`, () => game.useCard(c.id))}
                  >
                    Play
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="card board">
          <h2>Leaderboard</h2>
          <ol>
            {leaderboard.length === 0 && <li className="empty">No calls yet. Be first.</li>}
            {leaderboard.map((s, i) => (
              <li key={s.player} className={s.player === me58 ? "mine" : ""}>
                <span className="rank">{i + 1}</span>
                <span className="who">{s.player === me58 ? "you" : shortKey(s.player)}</span>
                <span className="pts">{s.points.toLocaleString()}</span>
                <span className="best">🔥{s.best}</span>
              </li>
            ))}
          </ol>
          <div className="meta">
            {arena ? `${arena.players} players · ${arena.totalCalls.toLocaleString()} calls` : ""}
          </div>
        </section>

        <section className="card txlog">
          <h2>Onchain activity</h2>
          <ul>
            {log.length === 0 && <li className="empty">Your transactions appear here with their confirm time.</li>}
            {log.map((l) => (
              <li key={l.id} className={l.tone}>
                <span>{l.text}</span>
                {l.sig && (
                  <a href={EXPLORER(l.sig)} target="_blank" rel="noreferrer">
                    {l.ms} ms ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer>
        <p>
          Calls, settles and card plays are zero-fee transactions on a MagicBlock Ephemeral Rollup, priced by MagicBlock's
          SOL/USD oracle. Loot candles roll with MagicBlock VRF. No wallet or SOL needed: this page made you a burner key.
        </p>
        <p>
          Program <code>{shortKey(PROGRAM_ID.toBase58())}</code> ·{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            source
          </a>
        </p>
      </footer>

      {reveal !== null && (
        <div className="overlay" onClick={() => setReveal(null)}>
          <div className={`reveal playing big ${CARDS[reveal].rarity.toLowerCase()}`}>
            <div className="glyph">{CARDS[reveal].glyph}</div>
            <div className="name">{CARDS[reveal].name}</div>
            <div className="rarity">{CARDS[reveal].rarity}</div>
            <div className="effect">{CARDS[reveal].effect}</div>
            <div className="tap">tap to keep</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

function Chart({ ticks, entry }: { ticks: Tick[]; entry: number | null }) {
  const w = 600;
  const h = 180;
  if (ticks.length < 2) return <div className="chart empty">Waiting for oracle ticks…</div>;
  const values = ticks.map((t) => t.v).concat(entry !== null ? [entry] : []);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.15 || 0.01;
  const lo = min - pad;
  const hi = max + pad;
  const t0 = ticks[0].t;
  const t1 = ticks[ticks.length - 1].t;
  const x = (t: number) => ((t - t0) / Math.max(t1 - t0, 1)) * w;
  const y = (v: number) => h - ((v - lo) / (hi - lo)) * h;
  const path = ticks.map((t, i) => `${i ? "L" : "M"}${x(t.t).toFixed(1)},${y(t.v).toFixed(1)}`).join(" ");
  const last = ticks[ticks.length - 1];
  const rising = last.v >= ticks[0].v;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={path} className={rising ? "line up" : "line down"} />
      {entry !== null && <line x1="0" x2={w} y1={y(entry)} y2={y(entry)} className="entry" />}
      <circle cx={x(last.t)} cy={y(last.v)} r="4" className="dot" />
    </svg>
  );
}
