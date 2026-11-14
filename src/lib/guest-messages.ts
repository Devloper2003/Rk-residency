import { db } from "@/lib/db";
import { isAutomationEnabled, logAutomation } from "@/lib/automation-manager";
import { publishPagePost } from "@/lib/meta-marketing";

/**
 * guest-messages.ts — guest-facing + marketing automation plumbing.
 *
 * Everything here runs WITHOUT new infrastructure:
 *   - email  → the same Resend account already sending booking confirmations
 *              (Site Settings: email_api_key + email_from)
 *   - whatsapp → the same gateway configured for owner alerts (Admin →
 *              Payment Settings), extended to arbitrary guest numbers when
 *              the provider supports it (UltraMsg / Green API / AiSensy).
 *              CallMeBot is owner-only by design, so guest WhatsApp falls
 *              back to email automatically.
 *   - facebook → the Meta page connection the owner already links in
 *              Admin → Marketing (meta_page_id + meta_page_token).
 *
 * Per-item "already done" tracking (review sent, recovery sent, post shared)
 * lives in ONE SiteSetting row (key `automation_state`) as JSON — no schema
 * changes, safe for the small daily volumes of a single hotel.
 */

// ---------------------------------------------------------------------------
// Site URL
// ---------------------------------------------------------------------------

export function siteUrl(): string {
  return (
    process.env.SITE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://www.rkresidencyvrindavan.in"
  ).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Automation state (SiteSetting `automation_state` — JSON blob)
// ---------------------------------------------------------------------------

export interface AutomationState {
  /** bookingId -> ISO date the post-checkout review request was sent. */
  reviewSent?: Record<string, string>;
  /** bookingId -> ISO date the abandoned-booking recovery email was attempted. */
  recoverySent?: Record<string, string>;
  /** blogPost id -> ISO date the Facebook share was attempted. */
  fbShared?: Record<string, string>;
  /** IST date (YYYY-MM-DD) the daily digest last went out. */
  digestSentOn?: string;
}

const AUTOMATION_STATE_KEY = "automation_state";
const PRUNE_AFTER_MS = 90 * 86_400_000; // keep 90 days of markers

export async function readAutomationState(): Promise<AutomationState> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: AUTOMATION_STATE_KEY } });
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value) as AutomationState;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAutomationState(next: AutomationState): Promise<void> {
  await db.siteSetting.upsert({
    where: { key: AUTOMATION_STATE_KEY },
    create: {
      key: AUTOMATION_STATE_KEY,
      value: JSON.stringify(next),
      label: "Automation markers (internal)",
      category: "automation",
    },
    update: { value: JSON.stringify(next) },
  });
}

function pruneMap(map: Record<string, string> | undefined): Record<string, string> {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  const out: Record<string, string> = {};
  for (const [id, iso] of Object.entries(map || {})) {
    const t = Date.parse(iso);
    if (Number.isFinite(t) && t >= cutoff) out[id] = iso;
  }
  return out;
}

/** Read → set marker → prune → write. Cron-only writers, small volumes. */
export async function markAutomationDone(
  field: "reviewSent" | "recoverySent" | "fbShared",
  id: string,
  at: Date = new Date()
): Promise<void> {
  const state = await readAutomationState();
  const next: AutomationState = {
    reviewSent: pruneMap(state.reviewSent),
    recoverySent: pruneMap(state.recoverySent),
    fbShared: pruneMap(state.fbShared),
    digestSentOn: state.digestSentOn,
  };
  next[field] = { ...(next[field] || {}), [id]: at.toISOString() };
  await writeAutomationState(next);
}

/** Mark the daily digest as sent for this IST date (idempotency marker). */
export async function markDigestSent(istDate: string): Promise<void> {
  const state = await readAutomationState();
  const next: AutomationState = {
    reviewSent: pruneMap(state.reviewSent),
    recoverySent: pruneMap(state.recoverySent),
    fbShared: pruneMap(state.fbShared),
    digestSentOn: istDate,
  };
  await writeAutomationState(next);
}

// ---------------------------------------------------------------------------
// IST day helpers (hotel operates in Asia/Kolkata)
// ---------------------------------------------------------------------------

const IST_OFFSET_MIN = 330;

/** UTC Date of midnight IST for the IST day containing `d`. */
export function istDayStartUTC(d: Date = new Date()): Date {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MIN * 60_000);
}

/** Today's IST date as YYYY-MM-DD. */
export function todayIST(d: Date = new Date()): string {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Guest email (Resend — same account as booking confirmations)
// ---------------------------------------------------------------------------

async function emailConfig(): Promise<{ apiKey: string; from: string } | null> {
  const rows = await db.siteSetting.findMany({
    where: { key: { in: ["email_api_key", "email_from"] } },
    select: { key: true, value: true },
  });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!cfg.email_api_key) return null;
  return { apiKey: cfg.email_api_key, from: cfg.email_from || "bookings@rkresidencyvrindavan.in" };
}

export async function sendGuestEmail(
  to: string,
  subject: string,
  html: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const cfg = await emailConfig();
    if (!cfg) return { ok: false, error: "email_not_configured" };
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: cfg.from, to: [to], subject, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: (await res.text()).slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "network" };
  }
}

/** Minimal inline-styled email shell matching the site's teal/gold brand. */
export function emailShell(title: string, bodyHtml: string, ctaLabel?: string, ctaUrl?: string): string {
  const cta = ctaLabel && ctaUrl
    ? `<a href="${ctaUrl}" style="display:inline-block;margin:20px 0 4px;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:8px;">${ctaLabel}</a>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
<tr><td style="background:#0f766e;padding:18px 28px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RK RESIDENCY <span style="color:#fbbf24;">VRINDAVAN</span></td></tr>
<tr><td style="padding:28px;">
<h2 style="margin:0 0 14px;font-size:20px;color:#1e293b;">${title}</h2>
<div style="font-size:14px;line-height:1.7;color:#334155;">${bodyHtml}</div>
${cta}
</td></tr>
<tr><td style="padding:16px 28px;background:#f8fafc;color:#94a3b8;font-size:12px;border-top:1px solid #e2e8f0;">
RK Residency, Vrindavan &middot; <a href="${siteUrl()}" style="color:#0f766e;">www.rkresidencyvrindavan.in</a>
</td></tr>
</table></td></tr></table></body></html>`;
}

// ---------------------------------------------------------------------------
// Guest WhatsApp (gateway-aware; CallMeBot is owner-only → falls back to email)
// ---------------------------------------------------------------------------

export async function guestWhatsAppConfigured(): Promise<boolean> {
  const rows = await db.siteSetting.findMany({
    where: {
      key: { in: ["whatsapp_enabled", "whatsapp_guest_enabled"] },
    },
    select: { key: true, value: true },
  });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return cfg.whatsapp_enabled === "true" && cfg.whatsapp_guest_enabled === "true";
}

/**
 * Send one WhatsApp message to a GUEST through the configured gateway.
 * Providers that can text arbitrary numbers: ultramsg | greenapi | aisensy | meta.
 * meta = the owner's DIRECT Meta WhatsApp Cloud API connection
 * (whatsapp_meta_token + whatsapp_meta_phone_id; template optional via
 * whatsapp_meta_template — required outside the 24h service window).
 * callmebot (free personal gateway) can only reach the registered owner
 * phone, so it returns ok:false and callers fall back to email.
 */
export async function sendGuestWhatsApp(phone: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!(await guestWhatsAppConfigured())) return { ok: false, error: "guest_whatsapp_disabled" };
    const rows = await db.siteSetting.findMany({
      where: {
        key: {
          in: [
            "whatsapp_api_key",
            "whatsapp_provider",
            "whatsapp_ultramsg_instance",
            "whatsapp_greenapi_instance",
            "whatsapp_aisensy_campaign",
            "whatsapp_meta_token",
            "whatsapp_meta_phone_id",
            "whatsapp_meta_template",
            "whatsapp_meta_lang",
          ],
        },
      },
      select: { key: true, value: true },
    });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const key = cfg.whatsapp_api_key || cfg.whatsapp_meta_token;
    if (!key) return { ok: false, error: "gateway_key_missing" };
    const provider = (cfg.whatsapp_provider || "callmebot").trim().toLowerCase();
    const digits = phone.replace(/\D/g, "");

    if (provider === "ultramsg") {
      const instance = (cfg.whatsapp_ultramsg_instance || "").trim();
      if (!instance) return { ok: false, error: "instance_missing" };
      const res = await fetch(`https://api.ultramsg.com/${encodeURIComponent(instance)}/messages/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: key, to: digits, body: text.slice(0, 4096) }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const parsed: any = await res.json().catch(() => null);
      return { ok: res.ok && (parsed?.sent === "true" || parsed?.sent === true) };
    }

    if (provider === "greenapi") {
      const instance = (cfg.whatsapp_greenapi_instance || "").trim();
      if (!instance) return { ok: false, error: "instance_missing" };
      const res = await fetch(
        `https://api.green-api.com/waInstance${encodeURIComponent(instance)}/sendMessage/${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: `${digits}@c.us`, message: text.slice(0, 4000) }),
          signal: AbortSignal.timeout(10_000),
        }
      );
      const parsed: any = await res.json().catch(() => null);
      return { ok: res.ok && !!parsed?.idMessage };
    }

    if (provider === "aisensy") {
      const campaign = (cfg.whatsapp_aisensy_campaign || "").trim();
      if (!campaign) return { ok: false, error: "campaign_missing" };
      const res = await fetch("https://backend.aisensy.com/campaign/t1/api/v2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: key,
          campaignName: campaign,
          destination: digits,
          userName: "RK Residency",
          source: "guest-automation",
          templateParams: [text.replace(/[*_~`]/g, "").slice(0, 1024)],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const parsed: any = await res.json().catch(() => null);
      return { ok: res.ok && parsed?.success !== false };
    }

    if (provider === "meta") {
      const token = (cfg.whatsapp_meta_token || cfg.whatsapp_api_key || "").trim();
      const phoneId = (cfg.whatsapp_meta_phone_id || "").trim();
      if (!token || !phoneId) return { ok: false, error: "meta_config_missing" };
      const template = (cfg.whatsapp_meta_template || "").trim();
      const lang = (cfg.whatsapp_meta_lang || "en").trim() || "en";
      const payload = template
        ? {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: digits,
            type: "template",
            template: {
              name: template,
              language: { code: lang },
              components: [
                { type: "body", parameters: [{ type: "text", text: text.replace(/[*_~`]/g, "").slice(0, 1024) }] },
              ],
            },
          }
        : {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: digits,
            type: "text",
            text: { preview_url: false, body: text.slice(0, 4096) },
          };
      const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const parsed: any = await res.json().catch(() => null);
      if (!res.ok || !parsed?.messages?.[0]?.id) {
        return { ok: false, error: `meta_${res.status}${parsed?.error?.code ? `_${parsed.error.code}` : ""}` };
      }
      return { ok: true };
    }

    return { ok: false, error: "callmebot_owner_only" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "network" };
  }
}

// ---------------------------------------------------------------------------
// Facebook page auto-share (uses the Marketing tab's connected page)
// ---------------------------------------------------------------------------

/**
 * Share a published blog post to the connected Facebook Page. The `link`
 * makes Facebook render the website's link preview card (og:image — JPEG
 * since the OG fix, so it renders correctly in feed).
 */
export async function sharePostToFacebook(post: {
  id: string;
  title: string;
  excerpt: string | null;
  slug: string;
}): Promise<{ ok: boolean; reason?: string }> {
  // Admin → Automations switch. Silent skip WITHOUT the shared marker, so
  // re-enabling the automation (or a manual "Run now") can still share it.
  if (!(await isAutomationEnabled("fb_auto_share"))) {
    return { ok: false, reason: "automation_disabled" };
  }
  const state = await readAutomationState();
  if (state.fbShared?.[post.id]) return { ok: false, reason: "already_shared" };

  const rows = await db.siteSetting.findMany({
    where: { key: { in: ["meta_page_id", "meta_page_token"] } },
    select: { key: true, value: true },
  });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!cfg.meta_page_id || !cfg.meta_page_token) {
    await logAutomation(
      "fb_auto_share",
      `FB share "${post.title}"`,
      "skipped",
      "Facebook page connected nahi hai — Admin → Marketing me connect karein"
    );
    return { ok: false, reason: "meta_not_connected" };
  }

  const excerpt = (post.excerpt || "").trim().slice(0, 400);
  const message = excerpt ? `${post.title}\n\n${excerpt}` : post.title;
  const link = `${siteUrl()}/blog/${post.slug}`;
  const res = await publishPagePost(cfg.meta_page_id, cfg.meta_page_token, message, link);
  // Mark the attempt regardless of gateway outcome — retried shares are the
  // bigger evil (duplicate posts); failures are logged for the owner.
  await markAutomationDone("fbShared", post.id);
  await logAutomation(
    "fb_auto_share",
    `FB share "${post.title}"`,
    res.ok ? "ok" : "failed",
    res.ok
      ? `Facebook page par post kiya — ${link}`
      : "Facebook publish failed — Meta connection refresh karein (Admin → Marketing)"
  );
  if (!res.ok) {
    console.error("[fb-share] publish failed:", res.status, JSON.stringify(res.data)?.slice(0, 300));
    return { ok: false, reason: "publish_failed" };
  }
  return { ok: true };
}
