import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyAdmin } from "@/lib/admin-auth";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * Admin → Email Marketing — bulk campaign sender (separate from the small
 * Marketing Hub email composer).
 *
 * Serverless-safe design: the SEND is driven in BATCHES by the admin UI.
 *   1. POST action:"start"       → resolve audience (deduped, ≤500), open a
 *                                  campaign record holding the composed
 *                                  email (SiteSetting JSON), return the
 *                                  recipient list to the client.
 *   2. POST action:"send_batch"  → client posts chunks of ~25 emails; each
 *                                  call renders + sends immediately, updates
 *                                  the campaign counters, returns per-email
 *                                  results (live progress bar in the UI).
 *   3. POST action:"finalize"    → close the record (recipients + message
 *                                  body stripped), audit-log the totals.
 *   POST action:"test"           → one preview email to the owner's own
 *                                  from-address.
 *
 * Audiences:
 *   subscribers → NewsletterSubscriber list (optional language filter)
 *   guests      → unique guest emails from real bookings (never cancelled)
 *   all         → deduped union of both
 *   custom      → pasted comma/newline-separated list (validated, ≤500)
 *
 * Uses the SAME Resend account as booking confirmations (email_api_key +
 * email_from in Site Settings) — no new credentials, no new tables, every
 * campaign is audit-logged.
 */

const CAMPAIGNS_KEY = "email_campaigns";
const CAMPAIGN_CAP = 30;
const RECIPIENT_CAP = 500;

interface CampaignRecord {
  id: string;
  at: string;
  subject: string;
  audience: string;
  total: number;
  sent: number;
  failed: number;
  status: "in_progress" | "completed";
  by: string;
  /** Present only while in_progress; stripped on finalize. */
  recipients?: string[];
  /** Composed content needed by send_batch; stripped on finalize. */
  message?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  sampleErrors?: string[];
}

async function readCampaigns(): Promise<CampaignRecord[]> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: CAMPAIGNS_KEY } });
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeCampaigns(list: CampaignRecord[]): Promise<void> {
  await db.siteSetting.upsert({
    where: { key: CAMPAIGNS_KEY },
    create: {
      key: CAMPAIGNS_KEY,
      value: JSON.stringify(list),
      label: "Bulk email campaign history (internal)",
      category: "marketing",
    },
    update: { value: JSON.stringify(list) },
  });
}

async function updateCampaign(id: string, patch: (c: CampaignRecord) => CampaignRecord): Promise<CampaignRecord | null> {
  const list = await readCampaigns();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  list[idx] = patch(list[idx]);
  await writeCampaigns(list);
  return list[idx];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Branded HTML — same visual language as the booking emails. */
function buildHtml(message: string, ctaLabel?: string, ctaUrl?: string): string {
  const paragraphs = message
    .split(/\n{2,}|\r\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#3d3a34;">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const cta =
    ctaUrl && ctaLabel
      ? `<p style="margin:22px 0 6px;"><a href="${esc(ctaUrl)}" style="background:#1D5B45;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:999px;font-size:15px;display:inline-block;">${esc(ctaLabel)}</a></p>`
      : "";
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#faf6ee;">
<div style="max-width:600px;margin:0 auto;padding:28px 20px;">
  <div style="text-align:center;padding-bottom:18px;border-bottom:2px solid #C9A227;">
    <span style="font-size:26px;color:#1D5B45;font-family:Georgia,serif;font-weight:bold;letter-spacing:0.5px;">RK Residency</span>
    <div style="font-size:11px;color:#8a8577;letter-spacing:3px;margin-top:4px;">VRINDAVAN</div>
  </div>
  <div style="padding:26px 6px;font-family:Arial,Helvetica,sans-serif;">
    ${paragraphs}
    ${cta}
  </div>
  <div style="border-top:1px solid #e5dfce;padding-top:16px;text-align:center;font-family:Arial,Helvetica,sans-serif;">
    <p style="margin:0;font-size:12px;color:#8a8577;">RK Residency, Near Shani Dev Mandir, Kailash Nagar, Vrindavan, UP 281121</p>
    <p style="margin:6px 0 0;font-size:12px;color:#8a8577;">+91 9760814931 &middot; <a href="https://www.rkresidencyvrindavan.in" style="color:#1D5B45;">www.rkresidencyvrindavan.in</a></p>
  </div>
</div>
</body></html>`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function resolveAudience(audience: string, language: string, customEmails?: string): Promise<string[]> {
  const out = new Set<string>();
  if (audience === "custom") {
    for (const raw of (customEmails || "").split(/[\n,;]+/)) {
      const e = raw.trim().toLowerCase();
      if (e && EMAIL_RE.test(e) && e.length <= 160) out.add(e);
    }
  } else {
    if (audience === "subscribers" || audience === "all") {
      const subs = await db.newsletterSubscriber.findMany({
        where: language === "all" ? {} : { language },
        select: { email: true },
        take: RECIPIENT_CAP,
      });
      for (const s of subs) if (EMAIL_RE.test(s.email)) out.add(s.email);
    }
    if (audience === "guests" || audience === "all") {
      const bookings = await db.booking.findMany({
        where: { status: { not: "CANCELLED" }, guestEmail: { not: "" } },
        select: { guestEmail: true },
        orderBy: { createdAt: "desc" },
        take: 2000,
      });
      for (const b of bookings) {
        const e = b.guestEmail.trim().toLowerCase();
        if (e && EMAIL_RE.test(e) && e.length <= 160) out.add(e);
      }
    }
  }
  return [...out].slice(0, RECIPIENT_CAP);
}

async function sendOne(apiKey: string, from: string, to: string, subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: (await res.text()).slice(0, 160) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "network" };
  }
}

async function loadConfig() {
  const rows = await db.siteSetting.findMany({
    where: { key: { in: ["email_api_key", "email_from", "email_provider"] } },
    select: { key: true, value: true },
  });
  const cfg: Record<string, string> = {};
  rows.forEach((r) => (cfg[r.key] = r.value));
  return {
    apiKey: cfg.email_api_key || "",
    fromEmail: cfg.email_from || "bookings@rkresidencyvrindavan.in",
    provider: cfg.email_provider || "resend",
  };
}

// ------------------------------- schemas -------------------------------

const composeSchema = z.object({
  subject: z.string().min(3).max(150),
  message: z.string().min(10).max(5000),
  ctaLabel: z.string().max(60).optional().or(z.literal("")),
  ctaUrl: z.string().url().max(500).optional().or(z.literal("")),
});

const startSchema = composeSchema.extend({
  action: z.literal("start"),
  audience: z.enum(["subscribers", "guests", "all", "custom"]),
  language: z.enum(["all", "en", "hi"]).default("all"),
  customEmails: z.string().max(20_000).optional(),
});

const actionSchema = z.discriminatedUnion("action", [
  startSchema,
  z.object({ action: z.literal("test") }).extend(composeSchema.shape),
  z.object({
    action: z.literal("send_batch"),
    campaignId: z.string().min(4).max(40),
    emails: z.array(z.string().email().max(160)).min(1).max(50),
  }),
  z.object({ action: z.literal("finalize"), campaignId: z.string().min(4).max(40) }),
]);

export async function GET(req: Request) {
  const admin = await verifyAdmin(req);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [subs, bookings, cfg, campaigns] = await Promise.all([
      db.newsletterSubscriber.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
      db.booking.findMany({
        where: { status: { not: "CANCELLED" }, guestEmail: { not: "" } },
        select: { guestEmail: true },
        orderBy: { createdAt: "desc" },
        take: 2000,
      }),
      loadConfig(),
      readCampaigns(),
    ]);
    const guests = new Set(bookings.map((b) => b.guestEmail.trim().toLowerCase()).filter((e) => e && EMAIL_RE.test(e)));
    const union = new Set([...guests, ...subs.map((s) => s.email.toLowerCase())]);
    return NextResponse.json({
      emailConfigured: cfg.provider === "resend" && !!cfg.apiKey,
      fromEmail: cfg.fromEmail,
      counts: {
        subscribers: subs.length,
        subscribersEn: await db.newsletterSubscriber.count({ where: { language: "en" } }),
        subscribersHi: await db.newsletterSubscriber.count({ where: { language: "hi" } }),
        guests: guests.size,
        all: union.size,
      },
      recentSubscribers: subs.slice(0, 20).map((s) => ({ email: s.email, name: s.name, language: s.language, createdAt: s.createdAt })),
      campaigns: campaigns
        .map(({ recipients: _r, message: _m, ctaLabel: _cl, ctaUrl: _cu, ...c }) => c)
        .slice(0, 15),
    });
  } catch (e) {
    console.error("[/api/admin/marketing/bulk-email GET] error:", e);
    return NextResponse.json({ error: "Failed to load email marketing data" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const admin = await verifyAdmin(req);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const parsed = actionSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }
    const data = parsed.data;
    const cfg = await loadConfig();
    const resendReady = cfg.provider === "resend" && !!cfg.apiKey;

    // — preview email to the owner's own address —
    if (data.action === "test") {
      if (!resendReady) {
        return NextResponse.json({ error: "Resend configured nahi hai — Site Settings me email_api_key save karein" }, { status: 409 });
      }
      const html = buildHtml(data.message, data.ctaLabel || undefined, data.ctaUrl || undefined);
      const res = await sendOne(cfg.apiKey, `RK Residency <${cfg.fromEmail}>`, cfg.fromEmail, data.subject, html);
      if (!res.ok) return NextResponse.json({ error: `Test email fail: ${res.error}` }, { status: 502 });
      return NextResponse.json({ ok: true, testedTo: cfg.fromEmail });
    }

    // — resolve audience + open the campaign record —
    if (data.action === "start") {
      if (!resendReady) {
        return NextResponse.json({ error: "Resend configured nahi hai — Site Settings me email_api_key save karein" }, { status: 409 });
      }
      const recipients = await resolveAudience(data.audience, data.language, data.customEmails);
      if (recipients.length === 0) {
        return NextResponse.json({ error: "Is audience me koi valid email nahi mila" }, { status: 409 });
      }
      const campaign: CampaignRecord = {
        id: `cmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        at: new Date().toISOString(),
        subject: data.subject,
        audience:
          data.audience +
          (data.audience !== "custom" && data.language !== "all" ? ` (${data.language})` : ""),
        total: recipients.length,
        sent: 0,
        failed: 0,
        status: "in_progress",
        by: admin.email,
        recipients,
        message: data.message,
        ctaLabel: data.ctaLabel || undefined,
        ctaUrl: data.ctaUrl || undefined,
      };
      const list = await readCampaigns();
      // Auto-close stale in_progress campaigns (browser closed mid-send).
      const HOUR = 3_600_000;
      for (const c of list) {
        if (c.status === "in_progress" && Date.now() - Date.parse(c.at) > HOUR) c.status = "completed";
      }
      await writeCampaigns([campaign, ...list].slice(0, CAMPAIGN_CAP));
      await db.auditLog.create({
        data: {
          adminId: admin.id,
          action: "BULK_EMAIL_STARTED",
          entity: "EmailCampaign",
          entityId: campaign.id,
          details: `"${data.subject}" → ${recipients.length} recipients (${campaign.audience})`,
        },
      });
      return NextResponse.json({ ok: true, campaignId: campaign.id, total: recipients.length, recipients });
    }

    // — send one batch (~25 emails), update counters —
    if (data.action === "send_batch") {
      if (!resendReady) {
        return NextResponse.json({ error: "Resend configured nahi hai" }, { status: 409 });
      }
      const campaign = (await readCampaigns()).find((c) => c.id === data.campaignId);
      if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
      if (campaign.status !== "in_progress" || !campaign.message) {
        return NextResponse.json({ error: "Campaign already closed — naya campaign start karein" }, { status: 409 });
      }
      const html = buildHtml(campaign.message, campaign.ctaLabel, campaign.ctaUrl);
      const results: { email: string; ok: boolean; error?: string }[] = [];
      const errors: string[] = [];
      for (const email of data.emails) {
        const r = await sendOne(cfg.apiKey, `RK Residency <${cfg.fromEmail}>`, email, campaign.subject, html);
        results.push({ email, ok: r.ok, error: r.error });
        if (!r.ok && errors.length < 5) errors.push(`${email}: ${r.error}`);
      }
      const sent = results.filter((r) => r.ok).length;
      const failed = results.length - sent;
      await updateCampaign(data.campaignId, (c) => ({
        ...c,
        sent: c.sent + sent,
        failed: c.failed + failed,
        sampleErrors: [...(c.sampleErrors || []), ...errors].slice(0, 5),
      }));
      return NextResponse.json({ ok: true, results, sent, failed });
    }

    // — close the campaign record —
    if (data.action === "finalize") {
      const updated = await updateCampaign(data.campaignId, (c) => {
        const { recipients: _r, message: _m, ctaLabel: _cl, ctaUrl: _cu, ...rest } = c;
        return { ...rest, status: "completed" as const };
      });
      if (!updated) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
      await db.auditLog.create({
        data: {
          adminId: admin.id,
          action: "BULK_EMAIL_COMPLETED",
          entity: "EmailCampaign",
          entityId: updated.id,
          details: `"${updated.subject}" → ${updated.sent} sent, ${updated.failed} failed of ${updated.total}`,
        },
      });
      return NextResponse.json({ ok: true, sent: updated.sent, failed: updated.failed, total: updated.total });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    console.error("[/api/admin/marketing/bulk-email POST] error:", e);
    return NextResponse.json({ error: "Bulk email action failed" }, { status: 500 });
  }
}
