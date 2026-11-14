import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyAdmin } from "@/lib/admin-auth";
import {
  clearAutomationLogs,
  isAutomationEnabled,
  logAutomation,
  readAutomationConfig,
  readAutomationLogs,
  setAutomationEnabled,
  type AutomationId,
} from "@/lib/automation-manager";
import { notifyOwnerWhatsApp, runRecoverySweep } from "@/lib/booking-sync";
import { maybeRunDailyOps, runReviewSweepNow } from "@/lib/daily-ops";
import { emailShell, readAutomationState, sendGuestEmail, sharePostToFacebook, siteUrl } from "@/lib/guest-messages";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * Admin → Automations — manage, execute and monitor the 6 website
 * automations from one place.
 *
 * GET  → catalog: per automation { enabled, ready, readyHint, lastRun }
 *        + rolling activity log (SiteSetting JSON — no schema changes).
 * POST → { action: "toggle" | "run" | "clear_logs", automation?, enabled? }
 *
 * Every action is admin-authenticated and audit-logged. "run" executes the
 * automation's real handler right now (safe: each automation stays
 * idempotent per booking/day/post even when run manually).
 */

const AUTOMATION_IDS = ["contact_alert", "daily_digest", "review_request", "recovery_email", "fb_auto_share", "newsletter_welcome"] as const;

interface CatalogItem {
  id: AutomationId;
  name: string;
  description: string;
  channel: string;
  enabled: boolean;
  ready: boolean;
  readyHint: string;
  lastRun?: { at: string; status: string; action: string; detail: string };
  count?: string;
}

async function getSettingValues(keys: string[]): Promise<Record<string, string>> {
  const rows = await db.siteSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function gatewayReady(): Promise<boolean> {
  const cfg = await getSettingValues(["whatsapp_enabled", "whatsapp_owner_phone", "whatsapp_api_key"]);
  return cfg.whatsapp_enabled === "true" && !!cfg.whatsapp_owner_phone && !!cfg.whatsapp_api_key;
}

async function emailReady(): Promise<boolean> {
  const cfg = await getSettingValues(["email_api_key"]);
  return !!cfg.email_api_key;
}

async function metaReady(): Promise<boolean> {
  const cfg = await getSettingValues(["meta_page_id", "meta_page_token"]);
  return !!cfg.meta_page_id && !!cfg.meta_page_token;
}

const CATALOG: Omit<CatalogItem, "enabled" | "ready" | "readyHint" | "lastRun" | "count">[] = [
  {
    id: "contact_alert",
    name: "Contact Form Alert",
    description: "Website ke contact form par jab koi enquiry aaye, turant aapke WhatsApp par poori detail (naam, phone, message).",
    channel: "WhatsApp → aapko",
  },
  {
    id: "daily_digest",
    name: "Daily Digest (8 AM)",
    description: "Roz subah 8 baje aapke WhatsApp par: aaj ke arrivals/departures, 24h bookings, pay-at-hotel dues, pending payments aur 7-day occupancy.",
    channel: "WhatsApp → aapko",
  },
  {
    id: "review_request",
    name: "Google Review Request",
    description: "Check-out ke agle din guest ko ek Google review request (WhatsApp/email) — har guest ko sirf ek baar.",
    channel: "WhatsApp/Email → guest",
  },
  {
    id: "recovery_email",
    name: "Abandoned Booking Recovery",
    description: "Online payment adhoora chhod kar chale gaye guests ko ~20 min baad ek gentle rebooking email.",
    channel: "Email → guest",
  },
  {
    id: "fb_auto_share",
    name: "Blog → Facebook Auto-Share",
    description: "Blog post publish hote hi aapke connected Facebook page par automatic share (link preview card ke saath).",
    channel: "Facebook page",
  },
  {
    id: "newsletter_welcome",
    name: "Newsletter Welcome Email",
    description: "Newsletter subscriber ko turant branded welcome email (active offer ke saath) + aapko heads-up.",
    channel: "Email → subscriber",
  },
];

async function buildCatalog(): Promise<CatalogItem[]> {
  const [cfg, logs, state, gwReady, emReady, metaOk, cancelledCount, publishedPosts, subscribers] = await Promise.all([
    readAutomationConfig(),
    readAutomationLogs(200),
    readAutomationState(),
    gatewayReady(),
    emailReady(),
    metaReady(),
    db.booking.count({ where: { status: "CANCELLED", paidAmount: 0, guestEmail: { not: "" } } }),
    db.blogPost.count({ where: { status: "PUBLISHED" } }),
    db.newsletterSubscriber.count(),
  ]);

  const readiness: Record<AutomationId, { ready: boolean; hint: string }> = {
    contact_alert: {
      ready: gwReady,
      hint: gwReady ? "" : "Admin → Payment Settings → WhatsApp Notifications me gateway ON karein",
    },
    daily_digest: {
      ready: gwReady,
      hint: gwReady ? "" : "Admin → Payment Settings → WhatsApp Notifications me gateway ON karein",
    },
    review_request: {
      ready: emReady || gwReady,
      hint: emReady || gwReady ? "" : "Site Settings me email_api_key (Resend) ya guest-capable WhatsApp gateway chahiye",
    },
    recovery_email: {
      ready: emReady,
      hint: emReady ? "" : "Site Settings me email_api_key (Resend) save karein",
    },
    fb_auto_share: {
      ready: metaOk,
      hint: metaOk ? "" : "Admin → Marketing Hub me Facebook page connect karein",
    },
    newsletter_welcome: {
      ready: emReady,
      hint: emReady ? "" : "Site Settings me email_api_key (Resend) save karein",
    },
  };

  return CATALOG.map((item) => {
    const last = logs.find((l) => l.automation === item.id);
    let count: string | undefined;
    if (item.id === "recovery_email") count = `${cancelledCount} cancelled bookings (48h window me scan hota hai)`;
    if (item.id === "fb_auto_share") count = `${publishedPosts} published posts`;
    if (item.id === "newsletter_welcome") count = `${subscribers} subscribers`;
    return {
      ...item,
      enabled: cfg[item.id]?.enabled !== false,
      ready: readiness[item.id].ready,
      readyHint: readiness[item.id].hint,
      lastRun: last ? { at: last.at, status: last.status, action: last.action, detail: last.detail } : undefined,
      count,
    };
  });
}

// — manual "Run now" handlers (each idempotent, safe to re-run) —

async function runAutomation(id: AutomationId): Promise<{ detail: string; ok: boolean }> {
  switch (id) {
    case "contact_alert": {
      const ok = await notifyOwnerWhatsApp(
        `*TEST — AUTOMATION CHECK*\nRK Residency automation panel se test alert. Agar ye message aapko dikh raha hai, Contact Form Alert sahi chal raha hai.`
      );
      await logAutomation(
        "contact_alert",
        "manual test alert",
        ok ? "ok" : "failed",
        ok ? "Test alert aapke WhatsApp par pahunch gaya" : "Gateway off/failed — Payment Settings me WhatsApp config karein"
      );
      return { ok, detail: ok ? "Test alert bhej diya — apna WhatsApp check karein" : "Gateway configured nahi hai ya send fail hua" };
    }
    case "daily_digest": {
      const res = await maybeRunDailyOps({ force: true });
      return {
        ok: res.digest.sent,
        detail: res.digest.sent
          ? `Digest bhej diya (${res.reviews.found} checkout guests mile, ${res.reviews.sent} ko review request)`
          : `Digest send nahi hua: ${res.digest.reason || "gateway fail"}`,
      };
    }
    case "review_request": {
      const res = await runReviewSweepNow();
      return {
        ok: res.sent === res.found,
        detail: res.found === 0
          ? "Kal koi check-out nahi hua — kal ke checkouts par ye khud chalega"
          : `${res.found} me se ${res.sent} guests ko review request bheji`,
      };
    }
    case "recovery_email": {
      const res = await runRecoverySweep();
      return {
        ok: true,
        detail: res.found === 0
          ? "Abhi koi abandoned booking nahi mili 48h window me"
          : `${res.found} me se ${res.sent} recovery emails bhejin`,
      };
    }
    case "fb_auto_share": {
      const state = await readAutomationState();
      const posts = await db.blogPost.findMany({
        where: { status: "PUBLISHED" },
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: { id: true, title: true, excerpt: true, slug: true },
      });
      const next = posts.find((p) => !state.fbShared?.[p.id]);
      if (posts.length === 0) {
        await logAutomation("fb_auto_share", "manual run", "skipped", "Koi published post nahi — publish hote hi auto-share hoga");
        return { ok: true, detail: "Koi published blog post nahi hai — pehla post publish karte hi auto-share hoga" };
      }
      if (!next) {
        await logAutomation("fb_auto_share", "manual run", "skipped", "Sab published posts pehle se share ho chuke hain");
        return { ok: true, detail: "Sab published posts already share ho chuke hain — naya post publish karte hi auto-share hoga" };
      }
      const res = await sharePostToFacebook(next);
      return {
        ok: res.ok,
        detail: res.ok
          ? `"${next.title}" FB page par share ho gaya`
          : `Share fail: ${res.reason === "meta_not_connected" ? "FB page connected nahi hai" : res.reason === "automation_disabled" ? "automation OFF hai" : "publish failed"}`,
      };
    }
    case "newsletter_welcome": {
      const cfg = await getSettingValues(["email_api_key", "email_from"]);
      if (!cfg.email_api_key) {
        await logAutomation("newsletter_welcome", "manual test", "failed", "Resend configured nahi hai");
        return { ok: false, detail: "Resend configured nahi hai — Site Settings me email_api_key save karein" };
      }
      const to = cfg.email_from || "bookings@rkresidencyvrindavan.in";
      const html = emailShell(
        "Welcome to the RK Residency family (TEST)",
        `<p>Namaste,</p><p>Ye ek test welcome email hai — naye subscribers ko exactly aisa hi email jata hai, active offer ke saath.</p>`,
        "Rooms & Booking",
        `${siteUrl()}/`
      );
      const res = await sendGuestEmail(to, "Welcome! RK Residency, Vrindavan (TEST)", html);
      await logAutomation(
        "newsletter_welcome",
        "manual test email",
        res.ok ? "ok" : "failed",
        res.ok ? `Test welcome email ${to} par bheji` : `Send failed: ${res.error || "unknown"}`
      );
      return { ok: res.ok, detail: res.ok ? `Test welcome email ${to} par bhej diya` : `Send fail: ${res.error || "unknown"}` };
    }
  }
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("toggle"),
    automation: z.enum(AUTOMATION_IDS),
    enabled: z.boolean(),
  }),
  z.object({
    action: z.literal("run"),
    automation: z.enum(AUTOMATION_IDS),
  }),
  z.object({ action: z.literal("clear_logs") }),
]);

export async function GET(req: Request) {
  const admin = await verifyAdmin(req);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [automations, logs] = await Promise.all([buildCatalog(), readAutomationLogs(100)]);
    return NextResponse.json({
      automations,
      logs,
      summary: {
        total: automations.length,
        enabled: automations.filter((a) => a.enabled).length,
        ready: automations.filter((a) => a.ready).length,
        lastActivityAt: logs[0]?.at || null,
      },
    });
  } catch (e) {
    console.error("[/api/admin/automations GET] error:", e);
    return NextResponse.json({ error: "Failed to load automations" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const admin = await verifyAdmin(req);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const parsed = actionSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid action", details: parsed.error.flatten() }, { status: 400 });
    }

    if (parsed.data.action === "toggle") {
      const { automation, enabled } = parsed.data;
      await setAutomationEnabled(automation, enabled);
      await db.auditLog.create({
        data: {
          adminId: admin.id,
          action: "AUTOMATION_TOGGLE",
          entity: "Automation",
          entityId: automation,
          details: `${automation} → ${enabled ? "ENABLED" : "DISABLED"}`,
        },
      });
      return NextResponse.json({ ok: true, automation, enabled });
    }

    if (parsed.data.action === "clear_logs") {
      await clearAutomationLogs();
      await db.auditLog.create({
        data: {
          adminId: admin.id,
          action: "AUTOMATION_LOGS_CLEARED",
          entity: "Automation",
          entityId: "logs",
          details: "Automation activity log cleared",
        },
      });
      return NextResponse.json({ ok: true });
    }

    // action === "run"
    const { automation } = parsed.data;
    const result = await runAutomation(automation);
    await db.auditLog.create({
      data: {
        adminId: admin.id,
        action: "AUTOMATION_MANUAL_RUN",
        entity: "Automation",
        entityId: automation,
        details: `${automation}: ${result.detail}`,
      },
    });
    return NextResponse.json({ ok: result.ok, automation, detail: result.detail });
  } catch (e) {
    console.error("[/api/admin/automations POST] error:", e);
    return NextResponse.json({ error: "Automation action failed" }, { status: 500 });
  }
}
