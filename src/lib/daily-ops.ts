import { db } from "@/lib/db";
import { notifyOwnerWhatsApp } from "@/lib/booking-sync";
import { isAutomationEnabled, logAutomation } from "@/lib/automation-manager";
import {
  emailShell,
  istDayStartUTC,
  markAutomationDone,
  markDigestSent,
  readAutomationState,
  sendGuestEmail,
  sendGuestWhatsApp,
  todayIST,
} from "@/lib/guest-messages";

/**
 * daily-ops.ts — the owner's morning automation, run once per IST day.
 *
 *   1. Daily digest → owner WhatsApp: today's arrivals & departures, new
 *      bookings in the last 24h, pay-at-hotel dues for today's arrivals,
 *      uncollected online payments, and average occupancy for the next
 *      7 days.
 *   2. Post-checkout review requests → every guest who checked out
 *      yesterday (IST) gets ONE WhatsApp/email asking for a Google review.
 *
 * Entrypoints:
 *   - /api/cron/daily-ops  (Vercel Cron 02:30 UTC = 08:00 IST)
 *   - publish-posts cron also calls maybeRunDailyOps() as a safety net, so
 *     the digest still fires even if the extra cron entry is unavailable on
 *     the Vercel plan (deduped via automation_state.digestSentOn — it can
 *     never send twice on the same IST day).
 */

const fmtINR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const fmtDay = (d: Date | string) =>
  new Date(d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

async function getSetting(key: string): Promise<string> {
  const row = await db.siteSetting.findUnique({ where: { key } });
  return row?.value ?? "";
}

async function getSettings(keys: string[]): Promise<Record<string, string>> {
  const rows = await db.siteSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// ---------------------------------------------------------------------------
// 1) Daily digest
// ---------------------------------------------------------------------------

interface DigestRow {
  room?: { name: string } | null;
  guestName: string;
  referenceCode: string;
  nights: number;
  totalAmount: number;
  paidAmount: number;
}

async function buildDigest(now: Date): Promise<string> {
  const dayStart = istDayStartUTC(now);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const last24h = new Date(now.getTime() - 86_400_000);

  const bookingSelect = {
    room: { select: { name: true } },
    guestName: true,
    referenceCode: true,
    nights: true,
    totalAmount: true,
    paidAmount: true,
  };

  const [arrivals, departures, newBookings, todayPayAtHotel, onlinePending, rooms] = await Promise.all([
    db.booking.findMany({
      where: { status: { in: ["CONFIRMED", "CHECKED_IN"] }, checkIn: { gte: dayStart, lt: dayEnd } },
      select: bookingSelect,
      orderBy: { checkIn: "asc" },
    }),
    db.booking.findMany({
      where: { status: { in: ["CONFIRMED", "CHECKED_IN", "CHECKED_OUT"] }, checkOut: { gte: dayStart, lt: dayEnd } },
      select: bookingSelect,
      orderBy: { checkOut: "asc" },
    }),
    db.booking.findMany({
      where: { status: { not: "CANCELLED" }, createdAt: { gte: last24h } },
      select: bookingSelect,
    }),
    db.booking.findMany({
      where: {
        status: { in: ["CONFIRMED", "CHECKED_IN"] },
        paymentMethod: "PAY_AT_HOTEL",
        checkIn: { gte: dayStart, lt: dayEnd },
      },
      select: { totalAmount: true, paidAmount: true },
    }),
    db.booking.findMany({
      where: {
        status: { in: ["PENDING", "CONFIRMED"] },
        paymentStatus: "PENDING",
        paymentMethod: { in: ["PREPAID", "PARTIAL_PAID"] },
      },
      select: { id: true },
    }),
    db.room.findMany({ select: { totalCount: true } }),
  ]);

  const fmtRows = (rows: DigestRow[], max = 5) =>
    rows
      .slice(0, max)
      .map((b) => `• ${b.room?.name || "Room"} — ${b.guestName} (${b.referenceCode}), ${b.nights}N`)
      .join("\n");

  const hotelDue = todayPayAtHotel.reduce((s, b) => s + Math.max(b.totalAmount - b.paidAmount, 0), 0);
  const collected = newBookings.reduce((s, b) => s + b.paidAmount, 0);

  // Average occupancy over the next 7 IST days (booked units / total units).
  const totalUnits = rooms.reduce((s, r) => s + r.totalCount, 0);
  let occAvg = 0;
  if (totalUnits > 0) {
    let occSum = 0;
    for (let i = 0; i < 7; i++) {
      const ds = new Date(dayStart.getTime() + i * 86_400_000);
      const de = new Date(ds.getTime() + 86_400_000);
      const booked = await db.booking.count({
        where: { status: { in: ["CONFIRMED", "CHECKED_IN"] }, checkIn: { lt: de }, checkOut: { gt: ds } },
      });
      occSum += Math.min(booked, totalUnits) / totalUnits;
    }
    occAvg = Math.round((occSum / 7) * 100);
  }

  const lines: string[] = [
    `*DAILY DIGEST — ${fmtDay(now)} — RK Residency*`,
    "",
    `Arrivals today: ${arrivals.length}`,
    arrivals.length ? fmtRows(arrivals) : "",
    `Departures today: ${departures.length}`,
    departures.length ? fmtRows(departures) : "",
    "",
    `New bookings (24h): ${newBookings.length} — ${fmtINR(collected)} collected`,
    `Pay-at-hotel dues today: ${fmtINR(hotelDue)} (${todayPayAtHotel.length} booking${todayPayAtHotel.length === 1 ? "" : "s"})`,
    `Online payments pending: ${onlinePending.length}`,
    `Occupancy (next 7 days avg): ${occAvg}%`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

// ---------------------------------------------------------------------------
// 2) Post-checkout review requests
// ---------------------------------------------------------------------------

async function googleReviewUrl(): Promise<string> {
  const custom = (await getSetting("google_review_url")).trim();
  if (custom) return custom;
  // Sensible fallback: the public Google search for the property's reviews.
  return "https://www.google.com/search?q=RK+Residency+Vrindavan+reviews";
}

async function runReviewSweep(now: Date, state: Awaited<ReturnType<typeof readAutomationState>>) {
  // Guests who checked out YESTERDAY (IST) — the morning-after touchpoint.
  const yesterdayStart = new Date(istDayStartUTC(now).getTime() - 86_400_000);
  const yesterdayEnd = istDayStartUTC(now);

  const candidates = await db.booking.findMany({
    where: {
      status: { in: ["CONFIRMED", "CHECKED_OUT"] },
      checkOut: { gte: yesterdayStart, lt: yesterdayEnd },
      guestEmail: { not: "" },
    },
    select: { id: true, guestName: true, guestEmail: true, guestPhone: true, referenceCode: true },
  });

  const pending = candidates.filter((b) => !state.reviewSent?.[b.id]);
  if (!pending.length) return { found: candidates.length, sent: 0 };

  const reviewUrl = await googleReviewUrl();
  let sent = 0;

  for (const b of pending) {
    const first = b.guestName.split(" ")[0] || b.guestName;
    const waText =
      `Namaste ${first}! Aapka stay RK Residency, Vrindavan me kaisa raha? ` +
      `Google par ek chhota review likhkar humein bahut madad milegi: ${reviewUrl} ` +
      `Dhanyavaad! Ref: ${b.referenceCode}`;
    const html = emailShell(
      `Aapke stay ke liye dhanyavaad, ${first}!`,
      `<p>Aap RK Residency, Vrindavan me humare guest rahe — ummeed hai aapka stay accha raha hoga.</p>` +
        `<p>Do minute nikaal kar Google par apna experience share karein. Aapka review naye guests ki madad karta hai aur humein behtar banata hai.</p>`,
      "Google par Review Likhein",
      reviewUrl
    );

    // WhatsApp first when a guest-capable gateway is configured; otherwise
    // (or on failure) the email path. Never both on success.
    let channel = "failed";
    const wa = b.guestPhone ? await sendGuestWhatsApp(b.guestPhone, waText) : { ok: false };
    if (wa.ok) {
      channel = "whatsapp";
      sent++;
    } else {
      const email = await sendGuestEmail(b.guestEmail, "Aapka review humari madad karega — RK Residency", html);
      channel = email.ok ? "email" : `failed:${email.error || "unknown"}`;
      if (email.ok) sent++;
    }

    // Mark regardless of delivery outcome: a failed send retried daily would
    // still be spam; the sweep window itself bounds the attempts.
    await markAutomationDone("reviewSent", b.id);
    console.log(`[daily-ops] review request ${b.referenceCode}: ${channel}`);
  }
  return { found: candidates.length, sent };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface DailyOpsResult {
  digest: { sent: boolean; reason?: string };
  reviews: { found: number; sent: number };
  at: string;
}

/**
 * Idempotent per IST day: the digest goes out at most once (digestSentOn
 * marker); the review sweep is idempotent per booking (reviewSent markers).
 * Safe to call from multiple cron entrypoints.
 */
export async function maybeRunDailyOps(opts?: { force?: boolean }): Promise<DailyOpsResult> {
  const now = new Date();
  const state = await readAutomationState();
  const today = todayIST(now);

  let digest: DailyOpsResult["digest"] = { sent: false };
  const digestEnabled = await isAutomationEnabled("daily_digest");
  if (!digestEnabled) {
    // Owner switched this automation off — skip WITHOUT marking the day, so
    // re-enabling later the same day still gets a fresh digest.
    digest = { sent: false, reason: "disabled_by_admin" };
  } else if (state.digestSentOn === today && !opts?.force) {
    digest = { sent: false, reason: "already_sent_today" };
  } else {
    try {
      const text = await buildDigest(now);
      console.log("[daily-ops] digest built:\n" + text);
      const ok = await notifyOwnerWhatsApp(text);
      digest = ok ? { sent: true } : { sent: false, reason: "whatsapp_not_configured_or_failed" };
      // Mark the day as done either way — a silent gateway should not retry
      // the digest on every admin page load; tomorrow's run gets a fresh try.
      await markDigestSent(today);
      await logAutomation(
        "daily_digest",
        opts?.force ? "digest (manual run)" : "digest",
        ok ? "ok" : "failed",
        ok
          ? `Sent to owner WhatsApp — ${arrivalsPreview(text)}`
          : "Gateway off/failed — check Admin → Payment Settings → WhatsApp"
      );
    } catch (e) {
      console.error("[daily-ops] digest failed:", e);
      digest = { sent: false, reason: "error" };
      await logAutomation("daily_digest", "digest", "failed", "Unexpected error building/sending digest");
    }
  }

  let reviews: DailyOpsResult["reviews"] = { found: 0, sent: 0 };
  const reviewsEnabled = await isAutomationEnabled("review_request");
  if (reviewsEnabled) {
    try {
      reviews = await runReviewSweep(now, state);
      // Log only when there was something to do — an empty daily sweep would
      // drown the activity log in noise.
      if (reviews.found > 0) {
        await logAutomation(
          "review_request",
          "review sweep",
          reviews.sent === reviews.found ? "ok" : "failed",
          `${reviews.sent}/${reviews.found} checkout guests ko Google review request bheji`
        );
      }
    } catch (e) {
      console.error("[daily-ops] review sweep failed:", e);
      await logAutomation("review_request", "review sweep", "failed", "Sweep error — see server logs");
    }
  }

  return { digest, reviews, at: now.toISOString() };
}

/** First numeric line of the digest (arrivals count) for a compact log detail. */
function arrivalsPreview(text: string): string {
  const m = text.match(/Arrivals today: (\d+)/);
  return m ? `${m[1]} arrivals today` : "daily stats";
}

/**
 * Manual "Run now" entry for Admin → Automations. Bypasses the once-per-day
 * digest marker (force) so the owner can test/preview immediately; the review
 * sweep stays idempotent per booking (never spams the same guest twice).
 */
export async function runReviewSweepNow(): Promise<{ found: number; sent: number }> {
  const state = await readAutomationState();
  return runReviewSweep(new Date(), state);
}
