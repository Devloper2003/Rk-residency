import { NextResponse } from "next/server";
import { verifyCronOrAdmin } from "@/lib/cron-auth";
import { maybeRunBlogAutopilot } from "@/lib/blog-autopilot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET/POST /api/cron/blog-autopilot — the #8 Blog Autopilot daily sweep
 * (Vercel Cron 03:40 UTC = 09:10 IST, see vercel.json).
 *
 * Protected by CRON_SECRET (Vercel Cron sends `Authorization: Bearer
 * <CRON_SECRET>`) or the owner's admin session ("Run now" in Admin →
 * Automations hits the admin API instead; this route accepts admin session
 * too so the scheduler can be triggered on demand).
 *
 * What it does:
 *   - Generates up to `perRun` (default 2) AI blog posts per sweep from the
 *     pending lanes: content-calendar live events → monthly trending
 *     report → evergreen topic rotation.
 *   - Publishes them per the owner's chosen mode in Admin → Automations:
 *     auto_drip (SCHEDULED on the next free ~3-day slot — the hourly
 *     publish-posts cron then publishes + Facebook-shares each one),
 *     instant (published now + FB-shared), or draft_only.
 *   - Self-guarded: respects the automation on/off switch, the weekly AI
 *     spend cap and the 6h cooldown, so re-running is always safe.
 *
 * The publish-posts hourly cron also calls maybeRunBlogAutopilot() as a
 * fallback on Vercel plans that cap cron jobs — both paths are safe to
 * double-run.
 */
async function runAutopilot() {
  const result = await maybeRunBlogAutopilot();
  return {
    ok: true,
    ran: result.ran,
    reason: result.reason || null,
    mode: result.mode,
    weekCount: result.weekCount,
    generated: result.generated,
    at: new Date().toISOString(),
  };
}

export async function GET(req: Request) {
  const auth = await verifyCronOrAdmin(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runAutopilot());
  } catch (e) {
    console.error("[/api/cron/blog-autopilot] error:", e);
    return NextResponse.json({ error: "Autopilot failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
