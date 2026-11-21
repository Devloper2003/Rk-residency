/**
 * custom-worker.ts — Cloudflare Worker entry for the OpenNext build.
 *
 * Re-uses the fetch handler that `opennextjs-cloudflare build` generates in
 * `.open-next/worker.js` and adds a `scheduled` handler so Cloudflare Cron
 * Triggers can fire the app's cron API routes.
 *
 * This REPLACES vercel.json (removed from the repo). The four Vercel Cron
 * schedules were migrated 1:1 into `triggers.crons` in wrangler.jsonc:
 *
 *   "0 6 * * *"   → /api/cron/publish-posts   (daily 06:00 UTC = 11:30 IST)
 *   "30 2 * * *"  → /api/cron/daily-ops       (daily 02:30 UTC = 08:00 IST)
 *   "0 5 1 * *"   → /api/cron/monthly-drafts  (1st of month 05:00 UTC)
 *   "40 3 * * *"  → /api/cron/blog-autopilot  (daily 03:40 UTC = 09:10 IST)
 *
 * How the invocation works:
 *   The scheduled handler calls the same endpoints Vercel Cron used to call,
 *   including the `Authorization: Bearer <CRON_SECRET>` header that
 *   src/lib/cron-auth.ts verifies. The call goes through the
 *   WORKER_SELF_REFERENCE service binding, so no public DNS is required —
 *   the neutral host `cron.internal` is neither canonical nor legacy, and
 *   the SEO middleware (src/middleware.ts) passes unknown hosts straight
 *   through instead of 301-redirecting them. If the binding is missing the
 *   handler falls back to fetching the public SITE_URL.
 *
 * Required Worker secrets/vars (Cloudflare → Workers → rk-residency-final →
 * Settings → Variables and Secrets):
 *   CRON_SECRET  — same value that used to live in the Vercel project env
 *   SITE_URL     — only used by the public-URL fallback (recommended anyway)
 *
 * Docs: https://opennext.js.org/cloudflare/howtos/custom-worker
 */

// @ts-ignore — `.open-next/worker.js` is generated at build time by
// `opennextjs-cloudflare build`; it does not exist until then.
import handler from "./.open-next/worker.js";

/**
 * Minimal structural types for the runtime pieces we touch, so this file
 * typechecks under the project tsconfig without depending on
 * @cloudflare/workers-types.
 */
interface CronWorkerEnv {
  WORKER_SELF_REFERENCE?: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
  CRON_SECRET?: string;
  SITE_URL?: string;
}

interface CronScheduledController {
  cron: string;
  scheduledTime: number;
}

interface CronExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Keys MUST match `triggers.crons` in wrangler.jsonc character-for-character. */
const CRON_ROUTES: Record<string, string> = {
  "0 6 * * *": "/api/cron/publish-posts",
  "30 2 * * *": "/api/cron/daily-ops",
  "0 5 1 * *": "/api/cron/monthly-drafts",
  "40 3 * * *": "/api/cron/blog-autopilot",
};

async function runCronRoute(env: CronWorkerEnv, cron: string): Promise<void> {
  const path = CRON_ROUTES[cron];
  if (!path) return; // unknown schedule — nothing mapped, nothing to do

  const headers = new Headers();
  if (env.CRON_SECRET) {
    // Exactly what Vercel Cron used to send; src/lib/cron-auth.ts verifies it.
    headers.set("Authorization", `Bearer ${env.CRON_SECRET}`);
  }

  try {
    let res: Response;
    if (env.WORKER_SELF_REFERENCE) {
      // Preferred path: service-binding self-fetch (no public DNS needed).
      res = await env.WORKER_SELF_REFERENCE.fetch(
        new Request(`https://cron.internal${path}`, { method: "GET", headers }),
      );
    } else {
      // Fallback: hit the public site directly.
      const base = (env.SITE_URL || "https://www.rkresidencyvrindavan.in").replace(/\/+$/, "");
      res = await fetch(`${base}${path}`, { method: "GET", headers });
    }

    if (!res.ok) {
      console.error(`[cron] ${cron} → ${path} failed: HTTP ${res.status}`);
    } else {
      console.log(`[cron] ${cron} → ${path} OK (${res.status})`);
    }
  } catch (err) {
    console.error(`[cron] ${cron} → ${path} threw:`, err);
  }
}

export default {
  // TEMP DEBUG (remove after diagnosis): wrap the OpenNext handler so ANY
  // exception that propagates out of the fetch chain is returned to the client
  // with its real name/message/stack instead of Cloudflare's opaque
  // "error code: 1101" body.
  async fetch(
    request: Request,
    env: CronWorkerEnv & Record<string, unknown>,
    ctx: CronExecutionContext,
  ): Promise<Response> {
    try {
      return await handler.fetch(request, env, ctx);
    } catch (err) {
      const detail =
        err instanceof Error
          ? `${err.name}: ${err.message}\n${err.stack ?? ""}`
          : String(err);
      console.error("[worker] uncaught from fetch chain:", detail.slice(0, 800));
      return new Response(`DEBUG_UNCAUGHT: ${detail.slice(0, 2000)}`, {
        status: 500,
      });
    }
  },
  scheduled(controller: CronScheduledController, env: CronWorkerEnv, ctx: CronExecutionContext) {
    ctx.waitUntil(runCronRoute(env, controller.cron));
  },
};
