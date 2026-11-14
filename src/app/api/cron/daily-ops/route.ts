import { NextResponse } from "next/server";
import { verifyCronOrAdmin } from "@/lib/cron-auth";
import { maybeRunDailyOps } from "@/lib/daily-ops";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/cron/daily-ops — the owner's 8 AM IST automation run.
 *
 * Protected by CRON_SECRET (Vercel Cron sends `Authorization: Bearer
 * <CRON_SECRET>`) or the owner's admin session ("Run now" from the panel).
 *
 * What it does (see src/lib/daily-ops.ts):
 *   1. Daily digest → owner WhatsApp (arrivals, departures, 24h bookings,
 *      pay-at-hotel dues, pending online payments, 7-day occupancy).
 *   2. Post-checkout review requests → guests who checked out yesterday.
 *
 * Both steps are idempotent per IST day / per booking, so the publish-posts
 * cron can safely call the same logic as a fallback on plans that limit the
 * number of cron jobs.
 */
async function runDailyOps() {
  return maybeRunDailyOps();
}

export async function GET(req: Request) {
  const auth = await verifyCronOrAdmin(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runDailyOps());
  } catch (e) {
    console.error("[/api/cron/daily-ops] error:", e);
    return NextResponse.json({ error: "Daily ops failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
