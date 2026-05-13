import type { ActionFn, Context, Event } from "@tenderly/actions";

// ── Constants ─────────────────────────────────────────────────────────────────

const PROD_BOT_WALLET =
  "0x08b20026003f3dF0E699D30B76E69C368dd2aa6c".toLowerCase();
const BASE_NETWORK_ID = "8453";

/** Tenderly throws (e.g. SecretNotFound) when a secret is not defined; optional secrets must use this. */
async function tryGetSecret(
  context: Context,
  key: string,
): Promise<string | null> {
  try {
    const v = await context.secrets.get(key);
    if (v == null) return null;
    const s = String(v).trim();
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

// ── US Equity Market Calendar (dynamic, any year) ────────────────────────────

/** Anonymous Gregorian algorithm for Easter Sunday. Returns [month (0-indexed), day]. */
function getEasterSunday(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/** Day-of-month of the nth occurrence of weekday (0=Sun) in month (0-indexed). n=-1 means last. */
function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number,
): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  let day = ((weekday - firstDow + 7) % 7) + 1;
  if (n > 0) {
    day += (n - 1) * 7;
  } else {
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    while (day + 7 <= daysInMonth) day += 7;
  }
  return day;
}

/** ISO date string for a fixed holiday, applying the US "nearest weekday" observation rule. */
function observedHoliday(year: number, month: number, day: number): string {
  const dow = new Date(Date.UTC(year, month, day)).getUTCDay();
  if (dow === 6) {
    const d = new Date(Date.UTC(year, month, day - 1));
    return isoDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (dow === 0) {
    const d = new Date(Date.UTC(year, month, day + 1));
    return isoDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  return isoDate(year, month, day);
}

function buildHolidaysForYear(year: number): Set<string> {
  const utcToIso = (ms: number) => {
    const d = new Date(ms);
    return isoDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };

  const [easterMonth, easterDay] = getEasterSunday(year);
  const goodFriday = utcToIso(
    Date.UTC(year, easterMonth, easterDay) - 2 * 86_400_000,
  );

  return new Set([
    observedHoliday(year, 0, 1), // New Year's Day (Jan 1)
    isoDate(year, 0, nthWeekdayOfMonth(year, 0, 1, 3)), // MLK Day (3rd Mon Jan)
    isoDate(year, 1, nthWeekdayOfMonth(year, 1, 1, 3)), // Presidents' Day (3rd Mon Feb)
    goodFriday, // Good Friday (Fri before Easter)
    isoDate(year, 4, nthWeekdayOfMonth(year, 4, 1, -1)), // Memorial Day (last Mon May)
    observedHoliday(year, 5, 19), // Juneteenth (Jun 19)
    observedHoliday(year, 6, 4), // Independence Day (Jul 4)
    isoDate(year, 8, nthWeekdayOfMonth(year, 8, 1, 1)), // Labor Day (1st Mon Sep)
    isoDate(year, 10, nthWeekdayOfMonth(year, 10, 4, 4)), // Thanksgiving (4th Thu Nov)
    observedHoliday(year, 11, 25), // Christmas (Dec 25)
  ]);
}

// Regular market ends at earlyCloseHour:00 ET; post-market does not apply
function buildEarlyClosesForYear(year: number): Record<string, number> {
  const earlyCloses: Record<string, number> = {};

  // Day after Thanksgiving
  const thanksgivingDay = nthWeekdayOfMonth(year, 10, 4, 4);
  const dayAfter = new Date(Date.UTC(year, 10, thanksgivingDay + 1));
  earlyCloses[
    isoDate(
      dayAfter.getUTCFullYear(),
      dayAfter.getUTCMonth(),
      dayAfter.getUTCDate(),
    )
  ] = 13;

  // Christmas Eve (Dec 24), only when it falls on a weekday
  const christmasEveDow = new Date(Date.UTC(year, 11, 24)).getUTCDay();
  if (christmasEveDow !== 0 && christmasEveDow !== 6) {
    earlyCloses[isoDate(year, 11, 24)] = 13;
  }

  return earlyCloses;
}

// ── DST / Eastern Time ────────────────────────────────────────────────────────

// Returns the ET UTC offset in milliseconds for a given UTC timestamp.
// EDT (UTC-4) runs from the second Sunday of March at 2:00 AM EST (07:00 UTC)
// through the first Sunday of November at 2:00 AM EDT (06:00 UTC).
function getEtOffsetMs(utcMs: number): number {
  const year = new Date(utcMs).getUTCFullYear();

  const march1Day = new Date(Date.UTC(year, 2, 1)).getUTCDay(); // 0=Sun
  const marchSecondSunday = (march1Day === 0 ? 1 : 8 - march1Day) + 7;
  const dstStartUtcMs = Date.UTC(year, 2, marchSecondSunday, 7, 0, 0); // 2 AM EST

  const nov1Day = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const novFirstSunday = nov1Day === 0 ? 1 : 8 - nov1Day;
  const dstEndUtcMs = Date.UTC(year, 10, novFirstSunday, 6, 0, 0); // 2 AM EDT

  return utcMs >= dstStartUtcMs && utcMs < dstEndUtcMs
    ? -4 * 60 * 60 * 1000 // EDT
    : -5 * 60 * 60 * 1000; // EST
}

function etComponents(utcMs: number): {
  year: number;
  month: number;
  date: number;
  dow: number;
  totalMin: number;
} {
  const offsetMs = getEtOffsetMs(utcMs);
  const et = new Date(utcMs + offsetMs);
  return {
    year: et.getUTCFullYear(),
    month: et.getUTCMonth(),
    date: et.getUTCDate(),
    dow: et.getUTCDay(), // 0=Sun … 6=Sat
    totalMin: et.getUTCHours() * 60 + et.getUTCMinutes(),
  };
}

function isoDate(year: number, month: number, date: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
}

function etDisplayTime(utcMs: number): string {
  const offsetMs = getEtOffsetMs(utcMs);
  const et = new Date(utcMs + offsetMs);
  const hh = String(et.getUTCHours()).padStart(2, "0");
  const mm = String(et.getUTCMinutes()).padStart(2, "0");
  const tz = offsetMs === -4 * 60 * 60 * 1000 ? "EDT" : "EST";
  return `${hh}:${mm} ${tz}`;
}

// ── Session Definitions ───────────────────────────────────────────────────────

interface SessionDef {
  name: "pre_market" | "regular_market" | "post_market";
  displayName: string;
  startHour: number;
  startMin: number;
  endHour: number;
  endMin: number;
  graceMin: number;
}

const SESSIONS: SessionDef[] = [
  {
    name: "pre_market",
    displayName: "Pre-Market",
    startHour: 4,
    startMin: 0,
    endHour: 9,
    endMin: 30,
    graceMin: 5,
  },
  {
    name: "regular_market",
    displayName: "Regular Market",
    startHour: 9,
    startMin: 30,
    endHour: 16,
    endMin: 0,
    graceMin: 5,
  },
  {
    name: "post_market",
    displayName: "Post-Market",
    startHour: 16,
    startMin: 0,
    endHour: 20,
    endMin: 0,
    graceMin: 5,
  },
];

// ── Active Session Detection ──────────────────────────────────────────────────

interface ActiveSession {
  def: SessionDef;
  dateStr: string;
  effectiveEndHour: number;
  effectiveEndMin: number;
  sessionStartUtcMs: number;
  sessionEndUtcMs: number;
  graceDeadlineUtcMs: number;
  pastGrace: boolean;
  tradingDayStatus: string;
}

function getActiveSession(nowUtcMs: number): ActiveSession | null {
  const { year, month, date, dow, totalMin } = etComponents(nowUtcMs);

  if (dow === 0 || dow === 6) return null; // weekend

  const dateStr = isoDate(year, month, date);
  if (buildHolidaysForYear(year).has(dateStr)) return null;

  const earlyCloseHour = buildEarlyClosesForYear(year)[dateStr] ?? null;
  const offsetMs = getEtOffsetMs(nowUtcMs);
  // Midnight ET expressed as UTC milliseconds for this calendar date
  const dayStartUtcMs = Date.UTC(year, month, date) - offsetMs;

  const tradingDayStatus =
    earlyCloseHour !== null
      ? `Early close – regular market ends ${earlyCloseHour}:00 ET`
      : "Normal trading day";

  for (const def of SESSIONS) {
    let effectiveEndHour = def.endHour;
    let effectiveEndMin = def.endMin;

    if (earlyCloseHour !== null) {
      if (def.name === "regular_market") {
        effectiveEndHour = earlyCloseHour;
        effectiveEndMin = 0;
      } else if (def.name === "post_market") {
        continue; // post-market cancelled on early-close days
      }
    }

    const startTotalMin = def.startHour * 60 + def.startMin;
    const endTotalMin = effectiveEndHour * 60 + effectiveEndMin;

    if (totalMin >= startTotalMin && totalMin < endTotalMin) {
      const sessionStartUtcMs = dayStartUtcMs + startTotalMin * 60_000;
      const sessionEndUtcMs = dayStartUtcMs + endTotalMin * 60_000;
      const graceDeadlineUtcMs = sessionStartUtcMs + def.graceMin * 60_000;

      return {
        def,
        dateStr,
        effectiveEndHour,
        effectiveEndMin,
        sessionStartUtcMs,
        sessionEndUtcMs,
        graceDeadlineUtcMs,
        pastGrace: nowUtcMs >= graceDeadlineUtcMs,
        tradingDayStatus,
      };
    }
  }

  return null;
}

// ── Wallet Balance Check (Base) ───────────────────────────────────────────────

const BASE_RPC_FALLBACK = "https://mainnet.base.org";
const MIN_ETH_BALANCE_FALLBACK = 0.01; // ETH
const BALANCE_ALERT_COOLDOWN_MS = 15 * 60 * 1000; // re-alert at most once per 15 minutes

async function fetchEthBalanceOnBase(
  context: Context,
  wallet: string,
): Promise<number> {
  const rpcUrl =
    (await tryGetSecret(context, "BASE_RPC_URL")) ?? BASE_RPC_FALLBACK;

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [wallet, "latest"],
    }),
  });

  if (!res.ok) throw new Error(`Base RPC ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    result?: string;
    error?: { message: string };
  };
  if (data.error)
    throw new Error(`eth_getBalance error: ${data.error.message}`);

  // result is a hex wei string; convert to ETH
  return Number(BigInt(data.result ?? "0x0")) / 1e18;
}

async function checkWalletBalance(
  context: Context,
  nowUtcMs: number,
  botWallet: string,
  balanceStorageKey: string,
): Promise<void> {
  let balanceEth: number;
  try {
    balanceEth = await fetchEthBalanceOnBase(context, botWallet);
  } catch (err) {
    console.error("[equity-monitor] Balance check failed:", err);
    return;
  }

  const rawThreshold = await tryGetSecret(context, "MIN_ETH_BALANCE_ETH");
  const thresholdEth = rawThreshold
    ? parseFloat(rawThreshold)
    : MIN_ETH_BALANCE_FALLBACK;

  console.log(
    `[equity-monitor] Base ETH balance: ${balanceEth.toFixed(6)} ETH (threshold: ${thresholdEth} ETH)`,
  );

  if (balanceEth >= thresholdEth) return;

  // Cooldown: don't spam if already alerted recently
  const stored = (await context.storage
    .getJson(balanceStorageKey)
    .catch(() => null)) as Record<string, unknown> | null;
  const lastAlertMs =
    typeof stored?.lastAlertUtcMs === "number" ? stored.lastAlertUtcMs : 0;
  if (nowUtcMs - lastAlertMs < BALANCE_ALERT_COOLDOWN_MS) {
    console.log(
      "[equity-monitor] Low balance already alerted within cooldown window — skipping.",
    );
    return;
  }

  const msg = [
    "⚠️ <b>Bot Wallet Low ETH Balance – Base</b>",
    "",
    "<b>Bot wallet:</b>",
    `<code>${botWallet}</code>`,
    "",
    `<b>Current balance:</b> ${balanceEth.toFixed(6)} ETH`,
    `<b>Threshold:</b> ${thresholdEth} ETH`,
    "",
    "<b>Action:</b>",
    "Top up the wallet on Base before the bot runs out of gas and fails to push prices.",
  ].join("\n");

  console.warn("[equity-monitor] Low balance — sending alert.");
  await sendTelegram(context, msg);
  await context.storage.putJson(balanceStorageKey, {
    lastAlertUtcMs: nowUtcMs,
    balanceEth,
  });
}

// ── On-Chain Transaction Query ────────────────────────────────────────────────

interface TxRecord {
  hash: string;
  from: string;
  to: string | null;
  status: boolean;
  timestampMs: number;
}

async function fetchRecentTransactions(
  context: Context,
  sinceUtcMs: number,
  botWallet: string,
): Promise<TxRecord[]> {
  const accessKey = await context.secrets.get("TENDERLY_ACCESS_KEY");
  const accountSlug = await context.secrets.get("TENDERLY_ACCOUNT_SLUG");
  const projectSlug = await context.secrets.get("TENDERLY_PROJECT_SLUG");

  if (!accessKey || !accountSlug || !projectSlug) {
    throw new Error(
      "Missing Tenderly secrets — ensure TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, and TENDERLY_PROJECT_SLUG are set",
    );
  }

  const params = new URLSearchParams({
    "filter[from]": botWallet,
    "filter[network_id]": BASE_NETWORK_ID,
    "filter[after]": new Date(sinceUtcMs).toISOString(),
    "sort[by]": "timestamp",
    "sort[order]": "desc",
    "page[size]": "50",
  });

  const url = `https://api.tenderly.co/api/v1/account/${accountSlug}/project/${projectSlug}/transactions?${params}`;
  const res = await fetch(url, { headers: { "X-Access-Key": accessKey } });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tenderly API ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    transactions?: Record<string, unknown>[];
  };
  return (data.transactions ?? []).map((tx) => ({
    hash: String(tx["hash"] ?? ""),
    from: String(tx["from"] ?? "").toLowerCase(),
    to: tx["to"] ? String(tx["to"]).toLowerCase() : null,
    status: Boolean(tx["status"]),
    timestampMs:
      typeof tx["timestamp"] === "string"
        ? new Date(tx["timestamp"]).getTime()
        : Number(tx["timestamp_unix"] ?? 0) * 1000,
  }));
}

async function hasValidPush(
  context: Context,
  session: ActiveSession,
  botWallet: string,
): Promise<boolean> {
  // Optional: restrict to specific oracle contract address
  const rawOracle = await tryGetSecret(context, "ORACLE_CONTRACT_ADDRESS");
  const oracleAddr = rawOracle ? rawOracle.toLowerCase() : null;

  const txs = await fetchRecentTransactions(
    context,
    session.sessionStartUtcMs,
    botWallet,
  );

  for (const tx of txs) {
    if (tx.from !== botWallet) continue;
    if (!tx.status) continue;
    if (
      tx.timestampMs < session.sessionStartUtcMs ||
      tx.timestampMs >= session.sessionEndUtcMs
    )
      continue;
    if (oracleAddr && tx.to !== oracleAddr) continue;
    return true;
  }

  return false;
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(context: Context, text: string): Promise<void> {
  const token = await tryGetSecret(context, "TELEGRAM_BOT_TOKEN");
  const chatId = await tryGetSecret(context, "TELEGRAM_CHAT_ID");

  if (!token || !chatId) {
    console.warn(
      "Telegram secrets not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)",
    );
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });

  if (!res.ok) {
    console.error("Telegram sendMessage failed:", res.status, await res.text());
  }
}

// ── Alert Formatting ──────────────────────────────────────────────────────────

function fmtEtTime(hour: number, min: number): string {
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")} ET`;
}

function buildAlertMessage(
  session: ActiveSession,
  nowUtcMs: number,
  botWallet: string,
): string {
  const sessionStart = fmtEtTime(session.def.startHour, session.def.startMin);
  const sessionEnd = fmtEtTime(
    session.effectiveEndHour,
    session.effectiveEndMin,
  );

  return [
    "🚨 <b>Equity Price Push Missing</b>",
    "",
    "<b>Bot wallet:</b>",
    `<code>${botWallet}</code>`,
    "",
    `<b>Session:</b> ${session.def.displayName}`,
    "",
    `<b>Expected window:</b> ${sessionStart} – ${sessionEnd}`,
    "",
    `<b>Current time:</b> ${etDisplayTime(nowUtcMs)}`,
    "",
    "<b>Reason:</b>",
    "No successful price push was detected from the bot wallet during the expected session window.",
    "",
    `<b>Calendar status:</b> ${session.tradingDayStatus}`,
    "",
    "<b>Action:</b>",
    "Check bot process, RPC health, wallet balance/gas, oracle contract status, upstream equities data provider, and Tenderly transaction traces.",
  ].join("\n");
}

// ── Main Action ───────────────────────────────────────────────────────────────

/**
 * @param botWallet – checks Base balance and Tenderly txs from this address
 * @param storagePrefix – keeps KV dedup / balance cooldown separate per deployed action
 */
export function createEquityPricePushMonitor(
  botWallet: string,
  storagePrefix = "equity_push_monitor",
): ActionFn {
  const balanceStorageKey = `${storagePrefix}:balance_low:last_alert_utcMs`;

  return async (context: Context, _event: Event) => {
    const nowUtcMs = Date.now();
    console.log(
      `[equity-monitor] ${new Date(nowUtcMs).toISOString()} / ${etDisplayTime(nowUtcMs)}`,
    );

    await checkWalletBalance(context, nowUtcMs, botWallet, balanceStorageKey);

    const session = getActiveSession(nowUtcMs);
    if (!session) {
      console.log("[equity-monitor] No active trading session — exiting.");
      return;
    }

    console.log(
      `[equity-monitor] Session: ${session.def.name} (${session.dateStr}), past grace: ${session.pastGrace}`,
    );

    if (!session.pastGrace) {
      console.log(
        `[equity-monitor] Grace period not elapsed (deadline ${etDisplayTime(session.graceDeadlineUtcMs)}).`,
      );
      return;
    }

    // Dedup: alert at most once per session per day
    const storageKey = `${storagePrefix}:${session.dateStr}:${session.def.name}`;
    const stored = (await context.storage
      .getJson(storageKey)
      .catch(() => null)) as Record<string, unknown> | null;

    if (stored?.alerted === true) {
      console.log(
        `[equity-monitor] Already alerted for ${session.def.name} on ${session.dateStr}.`,
      );
      return;
    }

    let pushFound = false;
    try {
      pushFound = await hasValidPush(context, session, botWallet);
    } catch (err) {
      // Don't false-alert on transient API errors
      console.error("[equity-monitor] Transaction query failed:", err);
      return;
    }

    if (pushFound) {
      console.log(
        `[equity-monitor] Valid push found for ${session.def.name} on ${session.dateStr}.`,
      );
      await context.storage.putJson(storageKey, {
        alerted: false,
        pushFoundAtUtcMs: nowUtcMs,
      });
      return;
    }

    const msg = buildAlertMessage(session, nowUtcMs, botWallet);
    console.warn("[equity-monitor] No push detected — sending alert.");
    await sendTelegram(context, msg);
    await context.storage.putJson(storageKey, {
      alerted: true,
      alertedAtUtcMs: nowUtcMs,
    });
  };
}

export const handleEquityPricePushMonitor: ActionFn =
  createEquityPricePushMonitor(PROD_BOT_WALLET);
