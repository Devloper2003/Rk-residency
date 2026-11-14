import { db } from "@/lib/db";
import { isAutomationEnabled, logAutomation, readAutomationConfig } from "@/lib/automation-manager";
import { buildDraftPrompt, callAnthropic, parseDraftJson, type DraftRequest } from "@/lib/ai-draft";
import { calcReadingMins, clampText, slugifyTitle } from "@/lib/blog-utils";
import { revalidatePostPaths } from "@/lib/blog-publish";
import { sharePostToFacebook } from "@/lib/guest-messages";

/**
 * blog-autopilot.ts — #8 "Blog Autopilot" automation.
 *
 * Boss's ask: "blog automatic publish ho jaye live events aur update ke
 * sath trending reports ke sath jisse aur engagement aaye" — the blog
 * should keep itself alive without anyone pressing Publish: posts about
 * live events (the owner's content calendar), a monthly Vrindavan travel
 * trends report, and evergreen guides, drip-published to maximise
 * engagement and auto-shared to Facebook by the existing fb_auto_share
 * automation.
 *
 * Content lanes (in priority order, up to `perRun` posts per sweep):
 *   1. Calendar backlog  — ContentCalendar rows for the current/next month
 *      with no linked post (the owner's real live events: Janmashtami,
 *      Holi, Ekadashi upwas...). This is the "live events" lane.
 *   2. Monthly trending report — one post per calendar month summarising
 *      what's on in Vrindavan this month (built from the calendar rows for
 *      that month — real owner data, never invented) plus seasonal travel
 *      guidance. This is the "trending reports" lane.
 *   3. Evergreen rotation — a fixed list of 12 evergreen topics (darshan
 *      guides, season advice, packing, itineraries...). Themes only — the
 *      AI writes generic guidance under the same strict no-invented-facts
 *      prompt policy, so nothing false can slip through.
 *
 * Publish modes (owner picks in Admin → Automations):
 *   - "auto_drip"  (default): posts are SCHEDULED on the next free drip
 *     slot (one post every ~3 days) — the existing publish-posts cron
 *     publishes them and Facebook-shares them automatically. Steady
 *     engagement instead of bursts.
 *   - "instant": published immediately + FB-shared right away.
 *   - "draft_only": nothing auto-publishes; drafts wait for the owner.
 *
 * Safety rails (AI content must never embarrass the hotel):
 *   - The ai-draft prompt already forbids invented facts and marks
 *     uncertain details with [VERIFY].
 *   - For auto_drip/instant, sanitizeForAutoPublish() DROPS every line
 *     containing [VERIFY]; if the remaining body is too thin (<250 words)
 *     the post falls back to DRAFT for human review instead of going live.
 *   - Weekly spend cap (`perWeek`, default 3) + per-run cap (`perRun`,
 *     default 2) protect the Anthropic bill; auto sweeps self-rate-limit
 *     to once per 6 hours. Manual "Run now" bypasses the 6h limiter but
 *     still respects the caps unless the owner runs it deliberately
 *     (force ignores the weekly counter only when there is backlog).
 *   - Zero schema changes: config lives in the automation_config
 *     SiteSetting row, state in blog_autopilot_state.
 */

export type AutopilotMode = "auto_drip" | "instant" | "draft_only";

export interface AutopilotConfig {
  mode: AutopilotMode;
  perRun: number;
  perWeek: number;
}

export interface AutopilotState {
  lastRunAt?: string;
  weekStart?: string; // IST week (Monday) as YYYY-MM-DD
  weekCount?: number;
  trendMonth?: string; // YYYY-MM the monthly trending report was generated for
  evergreenDone?: string[]; // evergreen topic ids already used
}

const STATE_KEY = "blog_autopilot_state";
const DEFAULT_CONFIG: AutopilotConfig = { mode: "auto_drip", perRun: 2, perWeek: 3 };
const AUTO_RUN_COOLDOWN_MS = 6 * 3600 * 1000; // automatic sweeps at most once per 6h
const MIN_WORDS_FOR_AUTO_PUBLISH = 250;
const DRIP_GAP_MS = 3 * 86_400_000; // one drip slot every ~3 days
const DRIP_MIN_DELAY_MS = 18 * 3600 * 1000; // never schedule sooner than ~18h out

// ---------------------------------------------------------------------------
// Config + state (SiteSetting JSON — no schema changes)
// ---------------------------------------------------------------------------

export async function readAutopilotConfig(): Promise<AutopilotConfig> {
  try {
    const cfg = await readAutomationConfig();
    const raw = cfg["blog_autopilot"] as (AutomationShape) | undefined;
    const mode = raw?.mode;
    return {
      mode: mode === "instant" || mode === "draft_only" ? mode : "auto_drip",
      perRun: clampInt(raw?.perRun, 1, 4, DEFAULT_CONFIG.perRun),
      perWeek: clampInt(raw?.perWeek, 1, 10, DEFAULT_CONFIG.perWeek),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

interface AutomationShape {
  enabled?: boolean;
  mode?: string;
  perRun?: number;
  perWeek?: number;
  updatedAt?: string;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

export async function setAutopilotMode(mode: AutopilotMode): Promise<void> {
  const cfg = await readAutomationConfig();
  const prev = (cfg["blog_autopilot"] as AutomationShape | undefined) || {};
  const next = {
    ...cfg,
    blog_autopilot: {
      enabled: prev.enabled !== false,
      mode,
      perRun: clampInt(prev.perRun, 1, 4, DEFAULT_CONFIG.perRun),
      perWeek: clampInt(prev.perWeek, 1, 10, DEFAULT_CONFIG.perWeek),
      updatedAt: new Date().toISOString(),
    },
  };
  await db.siteSetting.upsert({
    where: { key: "automation_config" },
    create: {
      key: "automation_config",
      value: JSON.stringify(next),
      label: "Automation on/off switches (internal)",
      category: "automation",
    },
    update: { value: JSON.stringify(next) },
  });
}

export async function readAutopilotState(): Promise<AutopilotState> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: STATE_KEY } });
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAutopilotState(next: AutopilotState): Promise<void> {
  await db.siteSetting.upsert({
    where: { key: STATE_KEY },
    create: {
      key: STATE_KEY,
      value: JSON.stringify(next),
      label: "Blog autopilot state (internal)",
      category: "automation",
    },
    update: { value: JSON.stringify(next) },
  });
}

// ---------------------------------------------------------------------------
// IST helpers (hotel operates in Asia/Kolkata)
// ---------------------------------------------------------------------------

function istDateParts(now: Date): { y: number; m: number; d: number; dow: number } {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return {
    y: ist.getUTCFullYear(),
    m: ist.getUTCMonth(),
    d: ist.getUTCDate(),
    dow: ist.getUTCDay(), // 0 = Sunday
  };
}

/** Monday of the current IST week as YYYY-MM-DD (weekly AI spend cap). */
function istWeekStart(now: Date): string {
  const { y, m, d, dow } = istDateParts(now);
  const mondayOffset = (dow + 6) % 7;
  const monday = new Date(Date.UTC(y, m, d - mondayOffset));
  return monday.toISOString().slice(0, 10);
}

function istMonth(now: Date, offsetMonths = 0): string {
  const { y, m } = istDateParts(now);
  const dt = new Date(Date.UTC(y, m + offsetMonths, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

// ---------------------------------------------------------------------------
// Safety: strip [VERIFY] lines before anything goes live unattended
// ---------------------------------------------------------------------------

export function sanitizeForAutoPublish(body: string): { body: string; clean: boolean; removed: number } {
  const lines = (body || "").split("\n");
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    if (line.includes("[VERIFY]")) {
      removed++;
      continue; // drop the whole uncertain sentence/line
    }
    kept.push(line);
  }
  const out = kept
    .join("\n")
    .replace(/\[VERIFY\]/g, "") // belt and braces
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const words = out.split(/\s+/).filter(Boolean).length;
  const clean = words >= MIN_WORDS_FOR_AUTO_PUBLISH && !out.includes("[VERIFY]");
  return { body: out, clean, removed };
}

// ---------------------------------------------------------------------------
// Evergreen topic rotation (themes only — never invented facts)
// ---------------------------------------------------------------------------

interface EvergreenTopic {
  id: string;
  event: string;
  category: string;
  keywords: string[];
}

const EVERGREEN_TOPICS: EvergreenTopic[] = [
  { id: "banke-bihari-darshan", event: "Banke Bihari Mandir darshan guide for first-time visitors", category: "TEMPLE_GUIDE", keywords: ["Banke Bihari Mandir darshan", "Banke Bihari temple guide", "Vrindavan temple darshan tips"] },
  { id: "best-time-to-visit", event: "Best time to visit Vrindavan — season-by-season travel guide", category: "LOCAL_TIP", keywords: ["best time to visit Vrindavan", "Vrindavan weather guide", "when to visit Vrindavan"] },
  { id: "weekend-from-delhi", event: "Perfect weekend trip to Vrindavan from Delhi", category: "LOCAL_TIP", keywords: ["Vrindavan weekend trip from Delhi", "Delhi to Vrindavan road trip", "2 day Vrindavan itinerary"] },
  { id: "temple-etiquette", event: "Temple etiquette in Vrindavan — what to wear, do and avoid", category: "TEMPLE_GUIDE", keywords: ["Vrindavan temple etiquette", "temple dress code Vrindavan", "first temple visit tips India"] },
  { id: "satvik-food", event: "Satvik food in Vrindavan — what to eat and where", category: "LOCAL_TIP", keywords: ["satvik food Vrindavan", "pure vegetarian food Vrindavan", "Vrindavan prasadam guide"] },
  { id: "packing-list", event: "What to pack for a Vrindavan temple trip", category: "LOCAL_TIP", keywords: ["Vrindavan trip packing list", "what to wear Vrindavan temple", "Vrindavan travel essentials"] },
  { id: "yamuna-aarti", event: "Yamuna aarti at Keshi Ghat — an experience guide", category: "EXPERIENCE", keywords: ["Yamuna aarti Keshi Ghat", "Keshi Ghat evening aarti", "Vrindavan ghat aarti experience"] },
  { id: "festival-season-booking", event: "Planning a Vrindavan stay in festival season — book early, stay smart", category: "LOCAL_TIP", keywords: ["Vrindavan hotel festival season booking", "Vrindavan Janmashtami stay", "where to stay in Vrindavan during festivals"] },
  { id: "mathura-vrindavan-2day", event: "Mathura–Vrindavan in two days — a calm, doable itinerary", category: "LOCAL_TIP", keywords: ["Mathura Vrindavan itinerary", "Mathura Vrindavan 2 day plan", "Braj trip plan"] },
  { id: "govardhan-parikrama", event: "Govardhan parikrama — a first-timer's walking guide", category: "EXPERIENCE", keywords: ["Govardhan parikrama guide", "Govardhan hill parikrama", "Braj parikrama for beginners"] },
  { id: "family-trip", event: "Vrindavan with family — a kid-friendly temple town guide", category: "LOCAL_TIP", keywords: ["Vrindavan family trip", "Vrindavan with kids", "family friendly Vrindavan stay"] },
  { id: "one-day-temple-circuit", event: "Nidhivan, Prem Mandir and ISKCON in one day", category: "TEMPLE_GUIDE", keywords: ["Nidhivan Prem Mandir ISKCON one day", "Vrindavan temple circuit", "Vrindavan one day tour"] },
];

// ---------------------------------------------------------------------------
// Candidate queue + generation
// ---------------------------------------------------------------------------

interface AutopilotCandidate {
  lane: "calendar" | "trending" | "evergreen";
  request: DraftRequest;
  calendarId?: string;
  topicId?: string;
  label: string;
}

async function buildCandidates(month: string, nextMonth: string, perRun: number, state: AutopilotState): Promise<AutopilotCandidate[]> {
  const out: AutopilotCandidate[] = [];

  // Lane 1 — live events from the owner's content calendar.
  const backlog = await db.contentCalendar.findMany({
    where: { linkedPostId: null, month: { in: [month, nextMonth] } },
    orderBy: [{ month: "asc" }, { event: "asc" }],
    take: perRun,
  });
  for (const row of backlog) {
    let keywords: string[] = [];
    try {
      keywords = JSON.parse(row.targetKeywords || "[]");
    } catch {
      /* none */
    }
    if (!keywords.length) keywords = [`${row.event} Vrindavan`];
    out.push({
      lane: "calendar",
      request: {
        event: row.event,
        month: row.month,
        category: row.category || "FESTIVAL",
        keywords,
        notes: row.notes || null,
      },
      calendarId: row.id,
      label: `${row.event} (${row.month})`,
    });
  }
  if (out.length >= perRun) return out.slice(0, perRun);

  // Lane 2 — one monthly trending report per calendar month.
  if (state.trendMonth !== month) {
    const monthRows = await db.contentCalendar.findMany({
      where: { month },
      orderBy: [{ event: "asc" }],
      select: { event: true, notes: true },
    });
    const eventsNote = monthRows.length
      ? `This month's events from the hotel's content calendar (write the report AROUND these): ${monthRows.map((r) => r.event).join(", ")}.`
      : "The content calendar has no confirmed events for this month yet — focus on the season itself (weather, crowd patterns, what is typically on in Vrindavan around this season) and keep every date claim unspecific.";
    out.push({
      lane: "trending",
      request: {
        event: `Vrindavan this month — events, updates and travel trends`,
        month,
        category: monthRows.length ? "FESTIVAL" : "LOCAL_TIP",
        keywords: ["Vrindavan events this month", "Vrindavan travel trends", monthLabel(month) + " Vrindavan"],
        notes: `Monthly "trending report" post for ${monthLabel(month)}. ${eventsNote} Structure it as a living monthly update: what's on, season trends, practical tips, and why booking a stay early helps. Keep the tone factual and evergreen-safe: never assert a specific festival DATE — say "expected mid-month" style only if the calendar note confirms it, otherwise refer to the month/season.`,
      },
      label: `Monthly trending report — ${month}`,
    });
    return out.slice(0, perRun);
  }

  // Lane 3 — evergreen rotation.
  const done = new Set(state.evergreenDone || []);
  const topic = EVERGREEN_TOPICS.find((t) => !done.has(t.id));
  if (topic) {
    out.push({
      lane: "evergreen",
      request: {
        event: topic.event,
        month,
        category: topic.category,
        keywords: topic.keywords,
        notes: `Evergreen guide (not tied to a specific date). Publish-safe: only well-known, stable facts about Vrindavan; mark anything uncertain with [VERIFY] and never state specific festival dates.`,
      },
      topicId: topic.id,
      label: topic.event,
    });
  }
  return out.slice(0, perRun);
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = slugifyTitle(base) || `post-${Date.now().toString(36)}`;
  for (let i = 2; i < 10; i++) {
    const exists = await db.blogPost.findUnique({ where: { slug }, select: { id: true } });
    if (!exists) return slug;
    slug = `${slugifyTitle(base)}-${i}`;
  }
  return `${slugifyTitle(base)}-${Date.now().toString(36)}`;
}

/** Next free drip slot: ~18h out, but always ≥3 days after the last scheduled post. */
async function nextDripSlot(now: Date): Promise<Date> {
  const last = await db.blogPost.findFirst({
    where: { status: "SCHEDULED", publishOn: { not: null } },
    orderBy: { publishOn: "desc" },
    select: { publishOn: true },
  });
  const minStart = now.getTime() + DRIP_MIN_DELAY_MS;
  const afterLast = (last?.publishOn?.getTime() || 0) + DRIP_GAP_MS;
  return new Date(Math.max(minStart, afterLast));
}

export interface AutopilotResultItem {
  label: string;
  lane: AutopilotCandidate["lane"];
  slug: string;
  title: string;
  outcome: "published" | "scheduled" | "draft" | "failed";
  detail: string;
}

export interface AutopilotRunResult {
  ran: boolean;
  reason?: string;
  generated: AutopilotResultItem[];
  weekCount: number;
  mode: AutopilotMode;
}

/** The real sweep. `force` = manual "Run now" (skips the 6h cooldown). */
export async function maybeRunBlogAutopilot(opts: { force?: boolean } = {}): Promise<AutopilotRunResult> {
  const now = new Date();
  const empty: AutopilotRunResult = { ran: false, generated: [], weekCount: -1, mode: "auto_drip" };

  // 1) Enabled? (admin switch — must never throw)
  const enabled = await isAutomationEnabled("blog_autopilot").catch(() => true);
  if (!enabled) {
    return { ...empty, reason: "automation disabled in admin" };
  }

  // 2) AI key present? (readiness hint is shown in admin)
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ...empty, reason: "ANTHROPIC_API_KEY not configured" };
  }

  // 3) Config + state + weekly cap + cooldown.
  const config = await readAutopilotConfig();
  const state = await readAutopilotState();
  const week = istWeekStart(now);
  const weekCount = state.weekStart === week ? state.weekCount || 0 : 0;
  if (!opts.force && weekCount >= config.perWeek) {
    return { ...empty, reason: `weekly cap reached (${weekCount}/${config.perWeek} this week)`, weekCount, mode: config.mode };
  }
  if (!opts.force && state.lastRunAt && now.getTime() - new Date(state.lastRunAt).getTime() < AUTO_RUN_COOLDOWN_MS) {
    return { ...empty, reason: "cooldown — ran less than 6h ago", weekCount, mode: config.mode };
  }

  // 4) Build the candidate queue and generate.
  const month = istMonth(now);
  const nextMonth = istMonth(now, 1);
  const candidates = await buildCandidates(month, nextMonth, config.perRun, state);
  if (candidates.length === 0) {
    await logAutomation("blog_autopilot", "sweep", "skipped", "Koi topic pending nahi — calendar backlog, trending report aur evergreen rotation sab done");
    return { ran: true, reason: "nothing pending", generated: [], weekCount, mode: config.mode };
  }

  const generated: AutopilotResultItem[] = [];
  let spentThisRun = 0;

  for (const cand of candidates) {
    if (weekCount + spentThisRun >= config.perWeek && !opts.force) break;
    try {
      const raw = await callAnthropic(buildDraftPrompt(cand.request));
      const draft = parseDraftJson(raw);
      const sanitized = sanitizeForAutoPublish(draft.body);
      const slug = await uniqueSlug(draft.slug || draft.title);
      const body = sanitized.body;
      const readingMins = Math.max(1, calcReadingMins(body));

      let outcome: AutopilotResultItem["outcome"];
      let detail: string;
      let postData: {
        status: "PUBLISHED" | "SCHEDULED" | "DRAFT";
        published: boolean;
        publishedAt: Date | null;
        publishOn: Date | null;
      };

      if (config.mode === "draft_only" || !sanitized.clean) {
        outcome = "draft";
        detail = config.mode === "draft_only" ? "draft_only mode — owner review pending" : `${sanitized.removed} [VERIFY] line(s) removed — body thin/uncertain, draft only`;
        postData = { status: "DRAFT", published: false, publishedAt: null, publishOn: null };
      } else if (config.mode === "instant") {
        outcome = "published";
        detail = "published instantly";
        postData = { status: "PUBLISHED", published: true, publishedAt: now, publishOn: null };
      } else {
        const slot = await nextDripSlot(now);
        outcome = "scheduled";
        detail = `scheduled for ${slot.toISOString()} (drip)`;
        postData = { status: "SCHEDULED", published: false, publishedAt: null, publishOn: slot };
      }

      const post = await db.blogPost.create({
        data: {
          slug,
          title: draft.title,
          excerpt: clampText(draft.excerpt, 400),
          body,
          category: cand.request.category || draft.category || "LOCAL_TIP",
          tags: JSON.stringify(draft.tags?.length ? draft.tags : cand.request.keywords),
          imageUrl: null,
          status: postData.status,
          published: postData.published,
          publishedAt: postData.publishedAt,
          publishOn: postData.publishOn,
          metaTitle: draft.metaTitle || clampText(draft.title, 60),
          metaDescription: draft.metaDescription || clampText(draft.excerpt, 155),
          targetKeyword: cand.request.keywords[0] || null,
          calendarId: cand.calendarId || null,
          aiGenerated: true,
          coverImageTitle: draft.coverImageTitle || null,
          coverImageBrief: draft.coverImageBrief || null,
          readingMins,
          readingMinsAuto: false,
        },
      });

      // Link the calendar row (best effort — another process may have claimed it).
      if (cand.calendarId) {
        try {
          await db.contentCalendar.update({
            where: { id: cand.calendarId },
            data: { linkedPostId: post.id, status: postData.status === "DRAFT" ? "DRAFTED" : "PUBLISHED" },
          });
        } catch {
          /* row claimed elsewhere — post is still fine */
        }
      }

      // Live surfaces + Facebook for anything already public.
      if (postData.status === "PUBLISHED") {
        revalidatePostPaths(post.slug);
        try {
          await sharePostToFacebook({ id: post.id, title: post.title, excerpt: post.excerpt, slug: post.slug });
          detail += " + FB share attempted";
        } catch {
          /* fb_auto_share logs its own outcome */
        }
      }

      await logAutomation(
        "blog_autopilot",
        outcome === "scheduled" ? "auto-scheduled post" : outcome === "published" ? "auto-published post" : "generated draft",
        "ok",
        `${cand.lane} lane: "${post.title}" → ${detail}`
      );
      generated.push({ label: cand.label, lane: cand.lane, slug: post.slug, title: post.title, outcome, detail });
      spentThisRun++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "generation failed";
      await logAutomation("blog_autopilot", "generate post", "failed", `${cand.label}: ${msg.slice(0, 200)}`);
      generated.push({ label: cand.label, lane: cand.lane, slug: "", title: cand.label, outcome: "failed", detail: msg.slice(0, 200) });
    }
  }

  // 5) Persist state: weekly counter, trending month, evergreen rotation.
  const nextEvergreen = new Set(state.evergreenDone || []);
  let trendMonth = state.trendMonth;
  for (const g of generated) {
    if (g.outcome === "failed") continue;
    if (g.lane === "trending") trendMonth = month;
  }
  const candByLabel = new Map(candidates.map((c) => [c.label, c] as const));
  for (const g of generated) {
    const c = candByLabel.get(g.label);
    if (c?.topicId && g.outcome !== "failed") nextEvergreen.add(c.topicId);
  }
  await writeAutopilotState({
    lastRunAt: now.toISOString(),
    weekStart: week,
    weekCount: weekCount + spentThisRun,
    trendMonth,
    evergreenDone: Array.from(nextEvergreen),
  });

  await logAutomation(
    "blog_autopilot",
    "sweep summary",
    generated.some((g) => g.outcome === "failed") ? (generated.every((g) => g.outcome === "failed") ? "failed" : "ok") : "ok",
    `${generated.length} topic(s) tried → ${generated.filter((g) => g.outcome !== "failed").length} ok (${config.mode} mode, week total ${weekCount + spentThisRun}/${config.perWeek})`
  );

  return { ran: true, generated, weekCount: weekCount + spentThisRun, mode: config.mode };
}
