import React, { useMemo, useState, useEffect } from "react";

/**
 * ABA Supervision Scheduler — plain React, single-file
 * - Generates supervision schedules within exact client windows + supervisor availability.
 * - Targets monthly hours; ≥1h blocks by default (configurable).
 * - 15-min rounding; supports closed dates; exports CSV; shows per-client progress.
 */

/* ------------------------- Types ------------------------- */
type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type TimeBlock = { start: number; end: number };
type DayWindow = { day: DayKey; blocks: TimeBlock[] };

interface ClientRule {
  id: string;
  monthlyHours: number; // projected supervision hours for the selected range
  minSessionMins?: number; // default 60
  preferNoSubHour?: boolean; // try to avoid <1hr
  windows: DayWindow[]; // authorized client windows (per weekday)
  maxSessionsPerWeek?: number | null; // optional per-client cap
  preferredDaySlots?: DayKey[][]; // e.g., [["mon","fri"],["tue","thu"]]
}

interface SupervisorConfig {
  activeDays: DayKey[]; // which weekdays you work
  unavailableDays: string[]; // YYYY-MM-DD closed dates
  dailyAvail: Record<DayKey, TimeBlock[]>; // your availability by weekday
  roundingMinutes: number; // e.g., 15
  allowSubHourIfUnavoidable: boolean;
  maxSessionsPerWeekPerClient?: number | null; // optional global cap
}

type ScheduleRequest = {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  clients: ClientRule[];
  supervisor: SupervisorConfig;
};

type ScheduledBlock = {
  date: string; // YYYY-MM-DD
  clientId: string;
  start: number; // minutes from midnight
  end: number;
};

/* ----------------------------- Utils ------------------------------ */
const DAY_ORDER: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const DATE_FMT = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`; // local YYYY-MM-DD
};

function toMins(hhmm: string): number {
  // allows "2 pm" or "2:30 pm"
  const m = hhmm.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!m) throw new Error("Bad time: " + hhmm);
  let h = parseInt(m[1], 10) % 12;
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  const pm = m[3].toLowerCase() === "pm";
  if (h > 12 || mins > 59) throw new Error("Invalid time: " + hhmm);
  return (pm ? h + 12 : h) * 60 + mins;
}
function toHHMM(mins: number): string {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h24 >= 12 ? "pm" : "am";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}
function toMDY(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}-${dd}-${yy}`;
}
function toWeekdayMDY(d: Date): string {
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = WEEKDAYS[d.getDay()];
  return `${weekday} ${toMDY(d)}`;
}
function parseISODateLocal(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1); // local midnight
}
function dayKeyFromDate(d: Date): DayKey {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][
    d.getDay()
  ] as DayKey;
}
function daterange(startISO: string, endISO: string): Date[] {
  const start = parseISODateLocal(startISO);
  const end = parseISODateLocal(endISO);
  const out: Date[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1))
    out.push(new Date(d));
  return out;
}
function overlapBlocks(a: TimeBlock[], b: TimeBlock[]): TimeBlock[] {
  const res: TimeBlock[] = [];
  for (const x of a)
    for (const y of b) {
      const s = Math.max(x.start, y.start);
      const e = Math.min(x.end, y.end);
      if (e > s) res.push({ start: s, end: e });
    }
  res.sort((u, v) => u.start - v.start);
  const merged: TimeBlock[] = [];
  for (const blk of res) {
    if (!merged.length || blk.start > merged[merged.length - 1].end)
      merged.push({ ...blk });
    else
      merged[merged.length - 1].end = Math.max(
        merged[merged.length - 1].end,
        blk.end
      );
  }
  return merged;
}
function minutesInBlocks(blocks: TimeBlock[]): number {
  return blocks.reduce((s, b) => s + (b.end - b.start), 0);
}
function normalizeClosedDates(
  raw: string,
  startDate: string,
  endDate: string
): string[] {
  const tokens = (raw || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const toISO = (t: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const mdy = t.match(/^(\d{2})-(\d{2})-(\d{2})$/); // MM-DD-YY
    if (mdy) {
      const [, mm, dd, yy] = mdy;
      const yyyy = parseInt(yy, 10) < 50 ? `20${yy}` : `19${yy}`;
      return `${yyyy}-${mm}-${dd}`;
    }
    return "";
  };
  const iso = tokens.map(toISO).filter(Boolean);
  const unique = Array.from(new Set(iso));
  const inRange = unique.filter((d) => d >= startDate && d <= endDate);
  return inRange.sort();
}

/* ------------- Availability & tightness helpers ------------------- */
function effectiveWindowsOnDate(
  date: Date,
  client: ClientRule,
  sup: SupervisorConfig
): TimeBlock[] {
  const day = dayKeyFromDate(date);
  const iso = DATE_FMT(date);

  if (!sup.activeDays.includes(day)) return [];
  if ((sup.unavailableDays || []).includes(iso)) return [];

  const clientBlocks = (client.windows || [])
    .filter((w) => w.day === day)
    .flatMap((w) => w.blocks || []);

  // Start from supervisor's normal weekday availability
  let supBlocks: TimeBlock[] = (sup.dailyAvail[day] || []).slice();

  // NEW: subtract date-specific unavailability if present
  const overrides: TimeBlock[] =
    (sup as any).dateOverrides?.[iso] ??
    (sup as any).oneOffUnavail?.[iso] ?? // if you added oneOffUnavail earlier
    [];

  if (overrides.length) {
    const subtract = (avail: TimeBlock[], block: TimeBlock): TimeBlock[] => {
      const out: TimeBlock[] = [];
      for (const a of avail) {
        if (block.end <= a.start || block.start >= a.end) {
          // no overlap
          out.push(a);
        } else {
          // left remainder
          if (block.start > a.start)
            out.push({ start: a.start, end: block.start });
          // right remainder
          if (block.end < a.end) out.push({ start: block.end, end: a.end });
        }
      }
      // merge/sort to keep clean
      out.sort((x, y) => x.start - y.start);
      const merged: TimeBlock[] = [];
      for (const b of out) {
        if (!merged.length || b.start > merged[merged.length - 1].end) {
          merged.push({ ...b });
        } else {
          merged[merged.length - 1].end = Math.max(
            merged[merged.length - 1].end,
            b.end
          );
        }
      }
      return merged;
    };

    for (const off of overrides) {
      supBlocks = subtract(supBlocks, off);
      if (!supBlocks.length) break;
    }
  }

  return overlapBlocks(clientBlocks, supBlocks);
}
function computeClientTightness(
  clients: ClientRule[],
  dates: Date[],
  sup: SupervisorConfig
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const c of clients) {
    let mins = 0;
    for (const d of dates)
      mins += minutesInBlocks(effectiveWindowsOnDate(d, c, sup));
    map[c.id] = mins;
  }
  return map; // smaller => tighter
}

/* ---- Core scheduling heuristic (even by week + 1/day + no back-to-back + robust) ---- */
function generateSchedule(req: ScheduleRequest): ScheduledBlock[] {
  const sup = req.supervisor;
  const rounding = Math.max(5, sup.roundingMinutes || 15);
  const allowSubHour = !!sup.allowSubHourIfUnavoidable;
  const DATE_ISO = DATE_FMT;

  const closed = sup.unavailableDays ?? [];
  const allDates = daterange(req.startDate, req.endDate).filter((d) => {
    const day = dayKeyFromDate(d);
    return sup.activeDays.includes(day) && !closed.includes(DATE_ISO(d));
  });

  // Remaining & min session per client
  const remaining: Record<string, number> = {};
  const minSession: Record<string, number> = {};
  for (const c of req.clients) {
    remaining[c.id] = Math.max(0, Math.round((c.monthlyHours || 0) * 60));
    minSession[c.id] = Math.max(15, c.minSessionMins || 60);
  }

  // Eligible dates per client
  const clientEligibleDates: Record<string, string[]> = {};
  for (const c of req.clients) {
    const elig: string[] = [];
    for (const date of allDates) {
      const day = dayKeyFromDate(date);
      const cBlocks = c.windows
        .filter((w) => w.day === day)
        .flatMap((w) => w.blocks);
      const sBlocks = sup.dailyAvail[day] ?? [];
      if (!cBlocks.length || !sBlocks.length) continue;
      if (overlapBlocks(cBlocks, sBlocks).length > 0) elig.push(DATE_ISO(date));
    }
    clientEligibleDates[c.id] = elig;
  }

  // Week key (Mon-based)
  const weekKey = (d: Date): string => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (x.getDay() + 6) % 7; // 0=Mon ... 6=Sun
    x.setDate(x.getDate() - dow);
    return DATE_ISO(x);
  };

  // Fast indices and helpers
  const idxByDate: Record<string, number> = {};
  allDates.forEach((d, i) => {
    idxByDate[DATE_ISO(d)] = i;
  });
  const roundDown = (mins: number): number =>
    Math.floor(mins / rounding) * rounding;

  const subtractFromAvail = (
    avail: TimeBlock[],
    place: TimeBlock
  ): TimeBlock[] => {
    const out: TimeBlock[] = [];
    for (const blk of avail) {
      if (place.end <= blk.start || place.start >= blk.end) {
        out.push(blk);
        continue;
      }
      if (place.start > blk.start)
        out.push({ start: blk.start, end: place.start });
      if (place.end < blk.end) out.push({ start: place.end, end: blk.end });
    }
    out.sort((a, b) => a.start - b.start);
    const merged: TimeBlock[] = [];
    for (const b of out) {
      if (!merged.length || b.start > merged[merged.length - 1].end)
        merged.push({ ...b });
      else
        merged[merged.length - 1].end = Math.max(
          merged[merged.length - 1].end,
          b.end
        );
    }
    return merged;
  };

  // Trackers
  const sessionsThisWeek: Record<string, Record<string, number>> = {};
  const lastScheduledISO: Record<string, string | undefined> = {};
  const slotSatisfied: Record<string, Record<string, boolean[]>> = {};

  // Per-week caps
  const perWeekCap: Record<string, number> = {};
  for (const c of req.clients) {
    const totalSessionsNeeded = Math.max(
      0,
      Math.ceil(remaining[c.id] / Math.max(15, minSession[c.id]))
    );
    const weeks = new Set(
      clientEligibleDates[c.id].map((iso) => weekKey(parseISODateLocal(iso)))
    );
    const eligibleWeeks = Math.max(1, weeks.size);
    let cap = Math.max(1, Math.ceil(totalSessionsNeeded / eligibleWeeks));
    if (typeof c.maxSessionsPerWeek === "number" && c.maxSessionsPerWeek > 0)
      cap = Math.min(cap, c.maxSessionsPerWeek);
    const g = sup.maxSessionsPerWeekPerClient as number | undefined;
    if (typeof g === "number" && g > 0) cap = Math.min(cap, g);
    perWeekCap[c.id] = cap;
  }

  const scheduled: ScheduledBlock[] = [];

  // Walk dates
  for (const date of allDates) {
    const iso = DATE_ISO(date);
    const day = dayKeyFromDate(date);
    const wk = weekKey(date);

    let dayAvail: TimeBlock[] = (sup.dailyAvail[day] || [])
      .slice()
      .sort((a, b) => a.start - b.start);

    // NEW: subtract one-off (date-specific) unavailability from today's availability
    const isoKey = DATE_ISO(date); // DATE_ISO is already defined above as DATE_FMT
    if (sup.oneOffUnavail && sup.oneOffUnavail[isoKey]?.length) {
      for (const off of sup.oneOffUnavail[isoKey]) {
        dayAvail = subtractFromAvail(dayAvail, off);
      }
    }

    if (!dayAvail.length) continue;

    const placedToday = new Set<string>();

    // a few passes; each pass places at most one chunk per client
    let safety = 0;
    while (dayAvail.length && safety++ < 30) {
      const candidatesBase = req.clients.filter(
        (c) => remaining[c.id] > 0 && clientEligibleDates[c.id].includes(iso)
      );
      if (!candidatesBase.length) break;

      const scored = candidatesBase
        .filter((c) => !placedToday.has(c.id))
        .map((c) => {
          const usedThisWeek = sessionsThisWeek[c.id]?.[wk] || 0;
          const canScheduleThisWeek = usedThisWeek < perWeekCap[c.id];

          const lastISO = lastScheduledISO[c.id];
          let avoidForB2B = false;
          if (lastISO) {
            const todayIdx = idxByDate[iso] ?? -1;
            const lastIdx = idxByDate[lastISO] ?? -1;
            avoidForB2B =
              todayIdx >= 0 && lastIdx >= 0 && todayIdx - lastIdx === 1;
          }

          const eligLeft =
            clientEligibleDates[c.id].filter((dISO) => {
              const idx = idxByDate[dISO] ?? -1;
              const todayIdx = idxByDate[iso] ?? 0;
              return idx >= todayIdx;
            }).length || 1;

          const perDayNeed = remaining[c.id] / eligLeft;

          const slots = c.preferredDaySlots || [];
          const todayKey = day as DayKey;
          let matchedSlotIdx = -1;
          if (slots.length) {
            const satisfiedArr =
              slotSatisfied[c.id]?.[wk] || new Array(slots.length).fill(false);
            for (let sIdx = 0; sIdx < slots.length; sIdx++) {
              if (!satisfiedArr[sIdx] && slots[sIdx].includes(todayKey)) {
                matchedSlotIdx = sIdx;
                break;
              }
            }
          }
          const slotMatchPriority = matchedSlotIdx >= 0 ? 1 : 0;

          return {
            c,
            perDayNeed,
            canScheduleThisWeek,
            avoidForB2B,
            slotMatchPriority,
            matchedSlotIdx,
          };
        })
        .sort((a, b) => {
          if (a.canScheduleThisWeek !== b.canScheduleThisWeek)
            return a.canScheduleThisWeek ? -1 : 1;
          if (a.slotMatchPriority !== b.slotMatchPriority)
            return b.slotMatchPriority - a.slotMatchPriority;
          if (a.avoidForB2B !== b.avoidForB2B) return a.avoidForB2B ? 1 : -1;
          return b.perDayNeed - a.perDayNeed;
        });

      let placedSomeone = false;

      for (const {
        c,
        perDayNeed,
        matchedSlotIdx,
        canScheduleThisWeek,
        slotMatchPriority,
      } of scored) {
        if (!dayAvail.length || placedToday.has(c.id) || remaining[c.id] <= 0)
          continue;
        if (!canScheduleThisWeek) continue;

        if ((c.preferredDaySlots || []).length && slotMatchPriority === 0) {
          const existsBetter = scored.some(
            (s) =>
              s.c.id !== c.id &&
              s.canScheduleThisWeek &&
              s.slotMatchPriority === 1 &&
              remaining[s.c.id] > 0
          );
          if (existsBetter) continue;
        }

        const cBlocks = c.windows
          .filter((w) => w.day === day)
          .flatMap((w) => w.blocks);
        const feasible = overlapBlocks(cBlocks, dayAvail).sort(
          (a, b) => a.start - b.start
        );
        if (!feasible.length) continue;

        const required = Math.max(
          minSession[c.id],
          allowSubHour ? rounding : minSession[c.id]
        );
        const blk =
          feasible.find((b) => b.end - b.start >= required) ?? feasible[0];

        let rawTarget = Math.min(
          remaining[c.id],
          blk.end - blk.start,
          perDayNeed
        );
        if (rawTarget < rounding) {
          if (
            blk.end - blk.start >= minSession[c.id] &&
            remaining[c.id] >= minSession[c.id]
          )
            rawTarget = minSession[c.id];
          else if (allowSubHour && blk.end - blk.start >= rounding)
            rawTarget = rounding;
        }

        let placeMins = roundDown(Math.max(0, rawTarget));
        if (placeMins < minSession[c.id]) {
          if (
            blk.end - blk.start >= minSession[c.id] &&
            remaining[c.id] >= minSession[c.id]
          ) {
            placeMins = roundDown(minSession[c.id]);
          } else if (allowSubHour && blk.end - blk.start >= rounding) {
            placeMins = roundDown(blk.end - blk.start);
          } else {
            continue;
          }
        }

        placeMins = Math.min(placeMins, blk.end - blk.start, remaining[c.id]);
        placeMins = roundDown(placeMins);
        if (placeMins <= 0) continue;

        const start = blk.start;
        const end = start + placeMins;

        scheduled.push({ date: iso, clientId: c.id, start, end });
        remaining[c.id] -= placeMins;
        dayAvail = subtractFromAvail(dayAvail, { start, end });
        placedToday.add(c.id);
        placedSomeone = true;

        sessionsThisWeek[c.id] = sessionsThisWeek[c.id] || {};
        sessionsThisWeek[c.id][wk] = (sessionsThisWeek[c.id][wk] || 0) + 1;
        lastScheduledISO[c.id] = iso;

        if (
          (c.preferredDaySlots || []).length &&
          typeof matchedSlotIdx === "number" &&
          matchedSlotIdx >= 0
        ) {
          slotSatisfied[c.id] = slotSatisfied[c.id] || {};
          const arr =
            slotSatisfied[c.id][wk] ||
            new Array((c.preferredDaySlots || []).length).fill(false);
          arr[matchedSlotIdx] = true;
          slotSatisfied[c.id][wk] = arr;
        }
      }

      if (!placedSomeone) break;
    }
  }

  /* ---------- TOP-UP PHASE: extend an existing block to remove tiny leftovers ---------- */
  {
    const byDate: Record<string, ScheduledBlock[]> = {};
    for (const b of scheduled) (byDate[b.date] ||= []).push(b);
    for (const d in byDate) byDate[d].sort((a, b) => a.start - b.start);

    function maxExtendEndForBlock(
      dateISO: string,
      block: ScheduledBlock
    ): number {
      const d = parseISODateLocal(dateISO);
      const day = dayKeyFromDate(d);

      const supBlocks = (sup.dailyAvail[day] || [])
        .slice()
        .sort((a, b) => a.start - b.start);
      const supContaining = supBlocks.find(
        (s) => s.start <= block.end && block.end <= s.end
      );
      if (!supContaining) return block.end;
      let limit = supContaining.end;

      const cRule = req.clients.find((c) => c.id === block.clientId);
      if (cRule) {
        const cWindows = cRule.windows
          .filter((w) => w.day === day)
          .flatMap((w) => w.blocks)
          .sort((a, b) => a.start - b.start);
        const cContaining = cWindows.find(
          (w) => w.start <= block.end && block.end <= w.end
        );
        if (!cContaining) return block.end;
        limit = Math.min(limit, cContaining.end);
      }

      const todays = byDate[dateISO] || [];
      const next = todays.find((b) => b.start > block.end && b !== block);
      if (next) limit = Math.min(limit, next.start);

      return Math.max(limit, block.end);
    }

    const step = Math.max(5, sup.roundingMinutes || 15);
    for (const c of req.clients) {
      const left = remaining[c.id] || 0;
      if (left <= 0 || left > step) continue;

      const datesAsc = Object.keys(byDate).sort();
      for (const iso of datesAsc) {
        const blocks = byDate[iso].filter((b) => b.clientId === c.id);
        if (!blocks.length) continue;

        for (const blk of blocks) {
          const maxEnd = maxExtendEndForBlock(iso, blk);
          const headroom = maxEnd - blk.end;

          if (headroom >= step) {
            const oldEnd = blk.end;
            blk.end += step;
            remaining[c.id] = Math.max(0, remaining[c.id] - step);

            const idx = scheduled.findIndex(
              (b) =>
                b === blk ||
                (b.date === blk.date &&
                  b.clientId === blk.clientId &&
                  b.start === blk.start &&
                  b.end === oldEnd)
            );
            if (idx >= 0) scheduled[idx].end = blk.end;

            break; // done topping up this client
          }
        }
        if ((remaining[c.id] || 0) <= 0) break;
      }
    }
  }
  return scheduled;
}

/* ------------------------------ UI ------------------------------- */
const styles = {
  wrap: {
    maxWidth: 1100,
    margin: "24px auto",
    padding: 16,
    fontFamily: "Inter, system-ui, Arial, sans-serif",
  } as React.CSSProperties,
  h1: {
    fontSize: 24,
    fontWeight: 700,
    marginBottom: 12,
  } as React.CSSProperties,
  card: {
    border: "1px solid #e5e7eb",
    borderRadius: 14, // was 12
    padding: 16,
    marginBottom: 16,
  } as React.CSSProperties,
  row: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 12,
    marginTop: 8,
  } as React.CSSProperties,
  label: {
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 6,
    display: "block",
  } as React.CSSProperties,
  input: {
    width: "100%",
    padding: "10px 12px", // a touch more padding
    border: "1px solid #cbd5e1", // slate-300
    borderRadius: 10,
    fontSize: 14,
  } as React.CSSProperties,
  btn2: {
    padding: "8px 12px",
    borderRadius: 10,
    background: "white",
    color: "#4f46e5", // indigo-600 text
    border: "1px solid #c7d2fe", // indigo-200 border
    cursor: "pointer",
    transition: "all 0.2s ease", // smooth hover effect
  } as React.CSSProperties,
  tabBtn: (active) => ({
    padding: "8px 12px",
    borderRadius: 10,
    border: active ? "1px solid #4f46e5" : "1px solid #d1d5db",
    background: active ? "#4f46e5" : "white",
    color: active ? "white" : "#111827",
    cursor: "pointer",
  }),
};

export default function App() {
  // ───────────────────────── state ─────────────────────────
  const [tab, setTab] = useState<"inputs" | "wizard" | "schedule">("wizard");
  useEffect(() => {
    const allowed = new Set(["inputs", "wizard", "schedule"]);
    if (!allowed.has(tab)) setTab("wizard");
  }, [tab]);

  const [startDate, setStartDate] = useState("2025-09-08");
  const [endDate, setEndDate] = useState("2025-09-30");
  useEffect(() => {
    if (startDate && endDate && startDate > endDate) {
      const a = startDate;
      setStartDate(endDate);
      setEndDate(a);
    }
  }, [startDate, endDate]);

  // Clients (wizard inputs)
  const [clients, setClients] = useState<ClientRule[]>([]);
  const [wizId, setWizId] = useState("");
  const [wizHours, setWizHours] = useState("");
  const [wizMinSession, setWizMinSession] = useState("60");
  const [wizMaxSessions, setWizMaxSessions] = useState("");
  const [wizPreferredSlots, setWizPreferredSlots] = useState<DayKey[][]>([
    [],
    [],
  ]);
  const [wizWindows, setWizWindows] = useState<Record<DayKey, string>>({
    sun: "",
    mon: "",
    tue: "",
    wed: "",
    thu: "",
    fri: "",
    sat: "",
  });
  const [wizPercent, setWizPercent] = useState("10"); // supervision %

  // Supervisor config
  const [supervisor, setSupervisor] = useState<SupervisorConfig>({
    activeDays: ["mon", "tue", "thu", "fri"],
    unavailableDays: [],
    roundingMinutes: 15,
    allowSubHourIfUnavoidable: false,
    maxSessionsPerWeekPerClient: null,
    dailyAvail: {
      sun: [],
      mon: [{ start: toMins("9:00 am"), end: toMins("6:00 pm") }],
      tue: [{ start: toMins("9:00 am"), end: toMins("6:00 pm") }],
      wed: [],
      thu: [{ start: toMins("9:00 am"), end: toMins("6:00 pm") }],
      fri: [{ start: toMins("9:00 am"), end: toMins("6:00 pm") }],
      sat: [],
    },
    oneOffUnavail: {}, // ISO "YYYY-MM-DD" -> array of {start,end} minute blocks
  });

  // request + schedule
  const [req, setReq] = useState<ScheduleRequest | null>(null);
  const schedule = useMemo(() => {
    if (!req) return [];
    try {
      return generateSchedule(req);
    } catch {
      return [];
    }
  }, [req]);

  // Autosave
  useEffect(() => {
    const payload = { startDate, endDate, clients, supervisor };
    try {
      localStorage.setItem("abaScheduler:v1", JSON.stringify(payload));
    } catch {}
  }, [startDate, endDate, clients, supervisor]);

  // Autoload
  useEffect(() => {
    try {
      const raw = localStorage.getItem("abaScheduler:v1");
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.startDate) setStartDate(saved.startDate);
      if (saved.endDate) setEndDate(saved.endDate);
      if (Array.isArray(saved.clients)) setClients(saved.clients);
      if (saved.supervisor) setSupervisor(saved.supervisor as SupervisorConfig);
    } catch (e) {
      console.error("Autoload failed:", e);
    }
  }, []);

  // Helpers for wizard
  function parseWizardDayBlocks(day: DayKey): TimeBlock[] {
    const raw = (wizWindows[day] || "").trim();
    if (!raw) return [];
    const blocks: TimeBlock[] = [];
    raw.split(",").forEach((part) => {
      const seg = part.trim();
      const pieces = seg.split("-").map((s) => s.trim());
      if (pieces.length !== 2) return;
      try {
        blocks.push({ start: toMins(pieces[0]), end: toMins(pieces[1]) });
      } catch {}
    });
    return blocks;
  }
  function toggleSlotDay(slotIdx: number, day: DayKey) {
    setWizPreferredSlots((prev) => {
      const copy = prev.map((s) => [...s]);
      const set = new Set(copy[slotIdx] || []);
      if (set.has(day)) set.delete(day);
      else set.add(day);
      copy[slotIdx] = Array.from(set) as DayKey[];
      return copy;
    });
  }
  function calcAttendedMinsFromWizardWindows(): number {
    const dates = daterange(startDate, endDate);
    const closed = supervisor.unavailableDays || [];
    let total = 0;
    for (const d of dates) {
      if (closed.includes(DATE_FMT(d))) continue;
      const dayKey = dayKeyFromDate(d);
      const blocks = parseWizardDayBlocks(dayKey);
      for (const b of blocks) if (b.end > b.start) total += b.end - b.start;
    }
    return total;
  }
  function autoCalcSupervisionHoursFromWizard(): void {
    const pct = parseFloat(wizPercent || "10");
    if (!(pct > 0)) {
      alert("Enter a supervision percent (e.g., 10).");
      return;
    }
    const attendedMins = calcAttendedMinsFromWizardWindows();
    const supHours = (attendedMins / 60) * (pct / 100);
    setWizHours(supHours.toFixed(2));
  }

  // Add/update client from wizard
  function addClient(): void {
    if (!wizId || !wizId.trim()) {
      alert("Client ID required");
      return;
    }
    const mh = parseFloat(wizHours || "0");
    if (!(mh > 0)) {
      alert(
        "Projected supervision hours (for this date range) must be greater than 0."
      );
      return;
    }
    const ms = parseInt(wizMinSession || "60", 10);
    const maxSessions = wizMaxSessions
      ? Math.max(1, parseInt(wizMaxSessions, 10))
      : null;

    // windows
    const windows: DayWindow[] = [];
    (Object.keys(wizWindows) as DayKey[]).forEach((day) => {
      const val = (wizWindows[day] || "").trim();
      if (!val) return;
      const blocks: TimeBlock[] = [];
      val.split(",").forEach((part) => {
        const [s, e] = part.split("-").map((x) => x.trim());
        try {
          const start = toMins(s);
          const end = toMins(e);
          if (end <= start) throw new Error("End must be after start");
          blocks.push({ start, end });
        } catch {}
      });
      if (blocks.length) windows.push({ day, blocks });
    });

    const preferred = (wizPreferredSlots || [])
      .map((slot) => (slot || []).filter(Boolean) as DayKey[])
      .filter((slot) => slot.length > 0);

    const client: ClientRule = {
      id: wizId.trim(),
      monthlyHours: mh,
      minSessionMins: ms,
      preferNoSubHour: true,
      windows,
      maxSessionsPerWeek: maxSessions,
      preferredDaySlots: preferred,
    };

    setClients((prev) => [...prev.filter((c) => c.id !== client.id), client]);

    // reset fields
    setWizId("");
    setWizHours("");
    setWizMinSession("60");
    setWizWindows({
      sun: "",
      mon: "",
      tue: "",
      wed: "",
      thu: "",
      fri: "",
      sat: "",
    });
    setWizMaxSessions("");
    setWizPreferredSlots([[], []]);
  }

  function minutesByClient(blocks: ScheduledBlock[]): Record<string, number> {
    const m: Record<string, number> = {};
    for (const b of blocks)
      m[b.clientId] = (m[b.clientId] || 0) + (b.end - b.start);
    return m;
  }
  function exportScheduleCSV(blocks: ScheduledBlock[]) {
    const header = ["Date", "Client", "Start", "End"];
    const lines = [header.join(",")];
    for (const b of blocks) {
      lines.push(
        [
          DATE_FMT(parseISODateLocal(b.date)),
          b.clientId,
          toHHMM(b.start),
          toHHMM(b.end),
        ].join(",")
      );
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "aba_supervision_schedule.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleGenerate() {
    if (!clients.length) {
      alert("Add at least one client first.");
      return;
    }
    setReq({ startDate, endDate, clients, supervisor });
    setTab("schedule");
  }

  function TabBtn(props: {
    id: "inputs" | "wizard" | "schedule";
    label: string;
  }) {
    const active = tab === props.id;
    return (
      <button
        type="button"
        style={styles.tabBtn(active)}
        onClick={() => setTab(props.id)}
      >
        {props.label}
      </button>
    );
  }

  // keep closed dates trimmed when range changes
  useEffect(() => {
    setSupervisor((s) => ({
      ...s,
      unavailableDays: (s.unavailableDays || []).filter(
        (d) => d >= startDate && d <= endDate
      ),
    }));
  }, [startDate, endDate]);

  /* ------------------------------ Render ------------------------------ */
  return (
    <div
      style={{
        padding: 20,
        fontFamily: "sans-serif",
        maxWidth: 980,
        margin: "0 auto",
      }}
    >
      <h1>ABA Supervision Scheduler</h1>

      {/* tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <TabBtn id="inputs" label="Supervisor & Dates" />
        <TabBtn id="wizard" label="Add Clients (Form)" />
        <TabBtn id="schedule" label="Schedule" />
      </div>

      {/* Inputs tab */}
      {tab === "inputs" && (
        <div>
          <div>
            <label>
              Start date:{" "}
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </label>
          </div>
          <div style={{ marginTop: 8 }}>
            <label>
              End date:{" "}
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </label>
          </div>

          <h3 style={{ marginTop: 16, marginBottom: 6 }}>
            Supervisor weekly availability (one range per line, e.g., 9:00 am -
            6:00 pm)
          </h3>

          {/* Active days */}
          <div style={{ marginBottom: 8 }}>
            <span style={{ marginRight: 8, fontWeight: 600 }}>
              Active days:
            </span>
            {DAY_ORDER.map((d) => (
              <label
                key={d}
                style={{ marginRight: 10, textTransform: "capitalize" }}
              >
                <input
                  type="checkbox"
                  checked={supervisor.activeDays.includes(d)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    const set = new Set(supervisor.activeDays);
                    on ? set.add(d) : set.delete(d);
                    setSupervisor({
                      ...supervisor,
                      activeDays: Array.from(set) as DayKey[],
                    });
                  }}
                />{" "}
                {d}
              </label>
            ))}
          </div>

          {/* Per-day time ranges */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 8,
            }}
          >
            {DAY_ORDER.map((day) => (
              <div
                key={day}
                style={{
                  border: "1px solid #eee",
                  borderRadius: 8,
                  padding: 8,
                }}
              >
                <div
                  style={{
                    textTransform: "capitalize",
                    fontWeight: 600,
                    marginBottom: 6,
                  }}
                >
                  {day}
                </div>
                <textarea
                  style={{
                    width: "100%",
                    minHeight: 90,
                    fontFamily: "ui-monospace, Menlo, monospace",
                  }}
                  defaultValue={(supervisor.dailyAvail[day] || [])
                    .map((b) => `${toHHMM(b.start)} - ${toHHMM(b.end)}`)
                    .join("\n")}
                  onBlur={(e) => {
                    const lines = e.target.value
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean);
                    const blocks: TimeBlock[] = [];
                    for (const line of lines) {
                      const [s, e2] = line.split("-").map((x) => x.trim());
                      try {
                        blocks.push({ start: toMins(s), end: toMins(e2) });
                      } catch {}
                    }
                    setSupervisor({
                      ...supervisor,
                      dailyAvail: { ...supervisor.dailyAvail, [day]: blocks },
                    });
                  }}
                  placeholder="e.g., 9:00 am - 12:00 pm&#10;1:00 pm - 5:00 pm"
                />
              </div>
            ))}
          </div>

          {/* Advanced options */}
          <div
            style={{
              display: "flex",
              gap: 12,
              marginTop: 12,
              alignItems: "center",
            }}
          >
            <label>
              Rounding (minutes):{" "}
              <input
                type="number"
                value={String(supervisor.roundingMinutes)}
                onChange={(e) =>
                  setSupervisor({
                    ...supervisor,
                    roundingMinutes: parseInt(e.target.value || "15", 10),
                  })
                }
                style={{ width: 80 }}
              />
            </label>
            <label>
              Max sessions/week per client:&nbsp;
              <input
                type="number"
                min={1}
                value={supervisor.maxSessionsPerWeekPerClient ?? ""}
                onChange={(e) =>
                  setSupervisor({
                    ...supervisor,
                    maxSessionsPerWeekPerClient: e.target.value
                      ? Math.max(1, parseInt(e.target.value, 10))
                      : null,
                  })
                }
                style={{ width: 80 }}
              />
            </label>
            <label>
              Allow &lt;1h if unavoidable:{" "}
              <select
                value={String(supervisor.allowSubHourIfUnavoidable)}
                onChange={(e) =>
                  setSupervisor({
                    ...supervisor,
                    allowSubHourIfUnavoidable: e.target.value === "true",
                  })
                }
              >
                <option value="false">No</option>
                <option value="true">Yes</option>
              </select>
            </label>
          </div>

          {/* Closed dates */}
          <div style={{ marginTop: 12 }}>
            <label
              style={{ fontWeight: 600, display: "block", marginBottom: 4 }}
            >
              Closed dates within this range (enter ISO like 2025-09-12 or
              MM-DD-YY like 09-12-25)
            </label>
            <input
              type="text"
              defaultValue={(supervisor.unavailableDays || [])
                .map((d) => toWeekdayMDY(parseISODateLocal(d)))
                .join(", ")}
              onBlur={(e) => {
                const next = normalizeClosedDates(
                  e.target.value,
                  startDate,
                  endDate
                );
                setSupervisor({ ...supervisor, unavailableDays: next });
                e.target.value = next.join(", ");
              }}
              placeholder="2025-09-12, 2025-09-19  (or 09-12-25, 09-19-25)"
              style={{
                width: "100%",
                padding: 8,
                border: "1px solid #d1d5db",
                borderRadius: 8,
              }}
            />
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              Only dates between <code>{startDate}</code> and{" "}
              <code>{endDate}</code> are kept.
            </div>
            <div style={{ marginTop: 12 }}>
              {/* One-off (date-specific) unavailability */}
              <div style={{ marginTop: 16 }}>
                <label
                  style={{ fontWeight: 600, display: "block", marginBottom: 6 }}
                >
                  One-off unavailability (specific date & time ranges)
                </label>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "220px 1fr auto",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <input
                    type="date"
                    id="oneoff-date"
                    min={startDate}
                    max={endDate}
                    style={{
                      padding: 8,
                      border: "1px solid #d1d5db",
                      borderRadius: 8,
                    }}
                  />
                  <input
                    id="oneoff-ranges"
                    placeholder="e.g., 1:00 pm - 2:30 pm, 4:00 pm - 5:00 pm"
                    style={{
                      width: "100%",
                      padding: 8,
                      border: "1px solid #d1d5db",
                      borderRadius: 8,
                    }}
                  />
                  <button
                    type="button"
                    style={styles.btn2}
                    onClick={() => {
                      const dateEl = document.getElementById(
                        "oneoff-date"
                      ) as HTMLInputElement;
                      const rangesEl = document.getElementById(
                        "oneoff-ranges"
                      ) as HTMLInputElement;
                      const iso = dateEl?.value;
                      const raw = rangesEl?.value || "";

                      if (!iso) {
                        alert("Pick a date.");
                        return;
                      }
                      if (!raw.trim()) {
                        alert("Enter one or more time ranges.");
                        return;
                      }

                      // Parse comma-separated ranges like "1:00 pm - 2:30 pm, 4:00 pm - 5:00 pm"
                      const blocks: TimeBlock[] = [];
                      raw.split(",").forEach((part) => {
                        const [s, e] = part.split("-").map((x) => x.trim());
                        if (!s || !e) return;
                        try {
                          const start = toMins(s);
                          const end = toMins(e);
                          if (end > start) blocks.push({ start, end });
                        } catch {
                          /* ignore malformed */
                        }
                      });

                      if (!blocks.length) {
                        alert("Could not parse any valid time ranges.");
                        return;
                      }

                      setSupervisor((prev) => {
                        const map = { ...(prev.oneOffUnavail || {}) };
                        const existing = map[iso] ? [...map[iso]] : [];
                        const merged = [...existing, ...blocks].sort(
                          (a, b) => a.start - b.start
                        );
                        const out: TimeBlock[] = [];
                        for (const b of merged) {
                          if (!out.length || b.start > out[out.length - 1].end)
                            out.push({ ...b });
                          else
                            out[out.length - 1].end = Math.max(
                              out[out.length - 1].end,
                              b.end
                            );
                        }
                        return {
                          ...prev,
                          oneOffUnavail: { ...map, [iso]: out },
                        };
                      });

                      // clear inputs
                      if (dateEl) dateEl.value = "";
                      if (rangesEl) rangesEl.value = "";
                    }}
                  >
                    Add
                  </button>
                </div>
                {/* ——— divider before generate ——— */}
                <div
                  style={{
                    borderTop: "1px solid #e5e7eb",
                    marginTop: 16,
                    paddingTop: 12,
                  }}
                >
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 14,
                      fontWeight: 700,
                      color: "#374151",
                    }}
                  >
                    Review & Generate
                  </h3>
                </div>
                <div
                  style={{
                    marginTop: 16,
                    display: "flex",
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    type="button"
                    style={styles.btn2}
                    onClick={handleGenerate}
                    onMouseEnter={(e) => {
                      (e.currentTarget.style.background = "#4f46e5"),
                        (e.currentTarget.style.color = "white");
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget.style.background = "white"),
                        (e.currentTarget.style.color = "#4f46e5");
                    }}
                  >
                    Generate Schedule
                  </button>
                </div>

                {/* Current one-offs */}
                <div style={{ marginTop: 10 }}>
                  {Object.keys(supervisor.oneOffUnavail || {}).length === 0 && (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      None yet. Add a date and time ranges above.
                    </div>
                  )}
                  {Object.entries(supervisor.oneOffUnavail || {})
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([iso, blocks]) => (
                      <div
                        key={iso}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          border: "1px solid #eee",
                          borderRadius: 8,
                          padding: "8px 10px",
                          marginBottom: 6,
                        }}
                      >
                        <div>
                          <b>{toWeekdayMDY(parseISODateLocal(iso))}</b>{" "}
                          <span style={{ fontSize: 12, opacity: 0.8 }}>
                            {blocks
                              .map(
                                (b) => `${toHHMM(b.start)} - ${toHHMM(b.end)}`
                              )
                              .join("; ")}
                          </span>
                        </div>
                        <button
                          type="button"
                          style={styles.btn2}
                          onClick={() =>
                            setSupervisor((prev) => {
                              const map = { ...(prev.oneOffUnavail || {}) };
                              delete map[iso];
                              return { ...prev, oneOffUnavail: map };
                            })
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Wizard tab */}
      {tab === "wizard" && (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <h2>Add Client</h2>

          {/* Client ID */}
          <div>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
            >
              Client ID
            </label>
            <input
              placeholder="e.g., GrBa"
              value={wizId}
              onChange={(e) => setWizId(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>

          {/* Supervision % + hours + auto-calc */}
          <div style={{ marginTop: 12 }}>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
            >
              Projected supervision hours for this date range
            </label>
            <input
              type="number"
              step="0.25"
              placeholder="e.g., 4.5"
              value={wizHours}
              onChange={(e) => setWizHours(e.target.value)}
              style={styles.input}
            />

            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-end",
                marginTop: 8,
                flexWrap: "wrap",
              }}
            >
              <div>
                <div style={{ fontSize: 12, marginBottom: 4 }}>
                  Supervision percent (%)
                </div>
                <input
                  type="number"
                  min={1}
                  max={100}
                  step="1"
                  placeholder="e.g., 10"
                  value={wizPercent}
                  onChange={(e) => setWizPercent(e.target.value)}
                  style={{ width: 120 }}
                />
              </div>
              <button
                type="button"
                style={styles.btn2}
                onClick={autoCalcSupervisionHoursFromWizard}
              >
                Auto-calc hours from % of attendance
              </button>
            </div>

            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
              Estimated attended hours in the selected date range (skipping
              closed dates):{" "}
              <b>{(calcAttendedMinsFromWizardWindows() / 60).toFixed(2)} h</b>.
              With <b>{parseFloat(wizPercent || "0")}%</b>, this yields{" "}
              <b>
                {(
                  (calcAttendedMinsFromWizardWindows() / 60) *
                  (parseFloat(wizPercent || "0") / 100)
                ).toFixed(2)}{" "}
                h
              </b>{" "}
              of supervision. Click <b>Auto-calc</b> to fill the box, or
              override manually.
            </div>
          </div>

          {/* Min session mins */}
          <div style={{ marginTop: 12 }}>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
            >
              Minimum session length (minutes)
            </label>
            <input
              type="number"
              value={wizMinSession}
              onChange={(e) => setWizMinSession(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>

          {/* Max sessions per week */}
          <div style={{ marginTop: 12 }}>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
            >
              Max sessions per week for this client (optional)
            </label>
            <input
              type="number"
              min={1}
              placeholder="e.g., 2"
              value={wizMaxSessions}
              onChange={(e) => setWizMaxSessions(e.target.value)}
              style={{ width: "100%" }}
            />
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
              Leave blank for no per-client cap (global cap still applies if
              set).
            </div>
          </div>

          {/* Preferred weekly day patterns (slots) */}
          <div style={{ marginTop: 12 }}>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 6 }}
            >
              Preferred weekly day pattern (slots)
            </label>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
              Create one or more <b>slots</b>. Each slot represents a session
              you want per week on <i>any</i> of the selected days. Example:
              Slot 1 = Mon/Fri and Slot 2 = Tue/Thu will try to schedule two
              sessions per week, one from each slot.
            </div>
            {wizPreferredSlots.map((slot, idx) => (
              <div
                key={idx}
                style={{
                  border: "1px solid #eee",
                  borderRadius: 8,
                  padding: 8,
                  marginBottom: 8,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Slot {idx + 1}
                </div>
                {DAY_ORDER.map((d) => (
                  <label
                    key={d}
                    style={{ marginRight: 10, textTransform: "capitalize" }}
                  >
                    <input
                      type="checkbox"
                      checked={(slot || []).includes(d)}
                      onChange={() => toggleSlotDay(idx, d)}
                    />{" "}
                    {d}
                  </label>
                ))}
              </div>
            ))}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setWizPreferredSlots((prev) => [...prev, []])}
              >
                + Add slot
              </button>
              {wizPreferredSlots.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    setWizPreferredSlots((prev) => prev.slice(0, -1))
                  }
                >
                  Remove last slot
                </button>
              )}
              <button
                type="button"
                onClick={() => setWizPreferredSlots([[], []])}
              >
                Reset to 2 slots
              </button>
            </div>
          </div>

          {/* Windows per day */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              Authorized windows (per day, comma separated ranges like{" "}
              <code>3:30 pm - 6:00 pm</code>)
            </div>
            {DAY_ORDER.map((day) => (
              <div key={day} style={{ marginTop: 4 }}>
                <b
                  style={{
                    textTransform: "capitalize",
                    display: "inline-block",
                    width: 40,
                  }}
                >
                  {day}
                </b>{" "}
                <input
                  style={{ width: "80%" }}
                  value={wizWindows[day]}
                  onChange={(e) =>
                    setWizWindows({ ...wizWindows, [day]: e.target.value })
                  }
                />
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style={{ marginTop: 12 }}>
            <button type="button" onClick={addClient}>
              Add / Update Client
            </button>
          </div>

          <h2 style={{ marginTop: 16 }}>Current Clients</h2>
          {clients.length === 0 && <div>None yet</div>}
          {clients.map((c) => (
            <div
              key={c.id}
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              <div>
                <b>{c.id}</b>: {c.monthlyHours}h min {c.minSessionMins}m{" "}
                {c.maxSessionsPerWeek ? `(cap ${c.maxSessionsPerWeek}/wk)` : ""}
              </div>
              <button
                type="button"
                onClick={() => {
                  setWizId(c.id);
                  setWizHours(String(c.monthlyHours));
                  setWizMinSession(String(c.minSessionMins ?? 60));
                  setWizMaxSessions(
                    c.maxSessionsPerWeek ? String(c.maxSessionsPerWeek) : ""
                  );
                  const byDay: Record<DayKey, string> = {
                    sun: "",
                    mon: "",
                    tue: "",
                    wed: "",
                    thu: "",
                    fri: "",
                    sat: "",
                  };
                  c.windows.forEach((w) => {
                    byDay[w.day] = (w.blocks || [])
                      .map((b) => `${toHHMM(b.start)} - ${toHHMM(b.end)}`)
                      .join(", ");
                  });
                  setWizWindows(byDay);
                  setWizPreferredSlots(c.preferredDaySlots ?? [[], []]);
                  setTab("wizard");
                }}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() =>
                  setClients((prev) => prev.filter((x) => x.id !== c.id))
                }
              >
                Remove
              </button>
            </div>
          ))}

          <div style={{ marginTop: 12 }}>
            <button type="button" onClick={handleGenerate}>
              Generate Schedule
            </button>
          </div>
        </div>
      )}

      {/* Per-client summary */}
      {schedule.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Summary</div>
          {(() => {
            const mins = minutesByClient(schedule);
            const rows = clients.map((c) => {
              const target = Math.round((c.monthlyHours || 0) * 60);
              const got = mins[c.id] || 0;
              const left = Math.max(0, target - got);
              return { id: c.id, target, got, left };
            });
            return (
              <div style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>
                {rows.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "120px 1fr 1fr 1fr",
                      gap: 8,
                    }}
                  >
                    <div>
                      <b>{r.id}</b>
                    </div>
                    <div>Target: {(r.target / 60).toFixed(2)}h</div>
                    <div>Scheduled: {(r.got / 60).toFixed(2)}h</div>
                    <div>Remaining: {(r.left / 60).toFixed(2)}h</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Schedule tab */}
      {tab === "schedule" && (
        <div
          style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}
        >
          <h2>Schedule</h2>
          {schedule.length === 0 && <div>No schedule yet</div>}
          {(() => {
            const byWeek: Record<string, ScheduledBlock[]> = {};
            for (const b of schedule) {
              const k = ((): string => {
                const d = parseISODateLocal(b.date);
                const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                const dow = (x.getDay() + 6) % 7; // Mon=0
                x.setDate(x.getDate() - dow);
                return DATE_FMT(x);
              })();
              (byWeek[k] ||= []).push(b);
            }
            const weeks = Object.keys(byWeek).sort();
            return weeks.map((wk) => (
              <div key={wk} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>
                  Week of {toWeekdayMDY(parseISODateLocal(wk))}
                </div>
                {byWeek[wk]
                  .sort(
                    (a, b) => a.date.localeCompare(b.date) || a.start - b.start
                  )
                  .map((b, i) => (
                    <div key={wk + "-" + i}>
                      <b>{toWeekdayMDY(parseISODateLocal(b.date))}</b> —{" "}
                      {b.clientId} {toHHMM(b.start)}–{toHHMM(b.end)}
                    </div>
                  ))}
              </div>
            ));
          })()}
          <div style={{ marginBottom: 8 }}>
            <button type="button" onClick={() => exportScheduleCSV(schedule)}>
              Export CSV
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
