import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyCronOrAdmin } from "@/lib/cron-auth";
import { revalidatePostPaths } from "@/lib/blog-publish";
import { sweepBookings } from "@/lib/booking-sync";
import { maybeRunDailyOps } from "@/lib/daily-ops";
import { maybeRunBlogAutopilot } from "@/lib/blog-autopilot";
import { sharePostToFacebook } from "@/lib/guest-messages";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/cron/publish-posts — the hourly scheduler.
 *
 * Protected by CRON_SECRET (Vercel Cron sends `Authorization: Bearer
 * <CRON_SECRET>`; configure it in Vercel → Settings → Environment
 * Variables). The owner's admin session is also accepted so "Run scheduler
 * now" in the admin panel can trigger the same run on demand.
 *
 * What it does:
 *   1. Publishes every SCHEDULED post whose publishOn time is due
 *      (status → PUBLISHED, published = true, publishedAt = publishOn).
 *      It also self-heals legacy rows still stuck at the pre-migration
 *      default status with published=true.
 *   2. Revalidates the blog list, each published post page, the homepage
 *      latest-posts section and the sitemap.
 *   3. Auto-shares every post published in THIS run to the connected
 *      Facebook Page (Marketing tab connection) — deduped per post.
 *   4. Runs the daily-ops fallback (morning digest + review requests) so
 *      the digest still fires on Vercel plans that cap the number of cron
 *      jobs — idempotent per IST day, safe to double-run.
 *   5. Booking payment lifecycle sweep — auto-cancel abandoned gateway
 *      sessions + reconcile pending Razorpay orders + abandoned-booking
 *      recovery emails (daily safety net; real-time correctness comes from
 *      the webhook + admin panel loads).
 *
 * A post with a FUTURE publishOn date is never touched here and never
 * appears in the blog list, the sitemap or the public HTML (the public
 * queries filter on published + publishedAt <= now).
 */
async function runScheduler() {
  const now = new Date();

  // 1) Publish due scheduled posts.
  const due = await db.blogPost.findMany({
    where: { status: "SCHEDULED", publishOn: { lte: now } },
    select: { id: true, slug: true, title: true, excerpt: true, publishOn: true },
  });
  let publishedNow = 0;
  for (const post of due) {
    await db.blogPost.update({
      where: { id: post.id },
      data: {
        status: "PUBLISHED",
        published: true,
        publishedAt: post.publishOn || now,
      },
    });
    publishedNow++;
  }

  // 1b) Self-heal pre-migration rows: published=true but status still at the
  // column default. Makes the owner's existing posts fully consistent even
  // if scripts/migrate-blog-status.ts has not been run yet.
  const legacy = await db.blogPost.findMany({
    where: { published: true, status: { not: "PUBLISHED" }, OR: [{ publishedAt: null }, { publishedAt: { lte: now } }] },
    select: { id: true },
  });
  for (const post of legacy) {
    await db.blogPost.update({ where: { id: post.id }, data: { status: "PUBLISHED" } });
  }

  // 2) Revalidate the surfaces that show posts.
  for (const post of due) {
    revalidatePostPaths(post.slug);
  }
  if (due.length === 0) revalidatePostPaths();

  // 2b) Facebook auto-share — every post published in THIS run goes to the
  //     connected Facebook Page (deduped per post via automation_state).
  let fbShared = 0;
  let fbSharedFailed = 0;
  for (const post of due) {
    try {
      const res = await sharePostToFacebook(post);
      if (res.ok) {
        fbShared++;
        console.log(`[/api/cron/publish-posts] shared to Facebook: ${post.slug}`);
      } else if (res.reason === "publish_failed") {
        fbSharedFailed++;
      }
    } catch (e) {
      console.error(`[/api/cron/publish-posts] FB share failed for ${post.slug}:`, e);
      fbSharedFailed++;
    }
  }

  // 2c) Daily-ops fallback — digest + review requests are idempotent per IST
  //     day / per booking, so running them here is always safe. On Vercel
  //     plans that cap cron jobs this is the ONLY path that fires them.
  let dailyOps: Awaited<ReturnType<typeof maybeRunDailyOps>> | null = null;
  try {
    dailyOps = await maybeRunDailyOps();
  } catch (e) {
    console.error("[/api/cron/publish-posts] daily-ops fallback failed:", e);
  }

  // 3) Booking payment lifecycle sweep — auto-cancel abandoned gateway
  // sessions + reconcile pending Razorpay orders + abandoned-booking recovery
  // emails (daily safety net; real-time correctness comes from the webhook +
  // admin panel loads).
  let bookingSweep = { cancelled: 0, reconciledPaid: 0, recovered: 0, skipped: false };
  try {
    bookingSweep = await sweepBookings();
  } catch (e) {
    console.error("[/api/cron/publish-posts] booking sweep failed:", e);
  }

  // 4) Blog Autopilot fallback (#8) — generate + schedule/publish AI posts
  //    (calendar events → monthly trending report → evergreen rotation).
  //    Self-guarded: 6h cooldown + weekly AI spend cap make hourly calls
  //    cheap no-ops unless new content is actually due.
  let autopilot: Awaited<ReturnType<typeof maybeRunBlogAutopilot>> | null = null;
  try {
    autopilot = await maybeRunBlogAutopilot();
  } catch (e) {
    console.error("[/api/cron/publish-posts] blog autopilot fallback failed:", e);
  }

  return {
    ok: true,
    publishedNow,
    healedLegacy: legacy.length,
    fb: { shared: fbShared, failed: fbSharedFailed },
    dailyOps,
    bookingSweep,
    autopilot: autopilot
      ? { ran: autopilot.ran, reason: autopilot.reason || null, generated: autopilot.generated.length }
      : null,
    at: now.toISOString(),
  };
}

export async function GET(req: Request) {
  const auth = await verifyCronOrAdmin(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runScheduler());
  } catch (e) {
    console.error("[/api/cron/publish-posts] error:", e);
    return NextResponse.json({ error: "Scheduler failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
