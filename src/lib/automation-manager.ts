import { db } from "@/lib/db";

/**
 * automation-manager.ts — admin-side control plane for the 6 website
 * automations. Lets the owner MANAGE (on/off), EXECUTE (run now) and
 * MONITOR (activity log) every automation from Admin → Automations.
 *
 * Zero schema changes: both the per-automation switches and the rolling
 * activity log live in SiteSetting rows as JSON:
 *
 *   automation_config  → { [automationId]: { enabled: boolean, updatedAt } }
 *   automation_logs    → [ { id, at, automation, action, status, detail } ]
 *                        newest first, hard-capped (LOG_CAP) entries.
 *
 * Missing config entry = automation ENABLED (safe default: the behaviours
 * shipped on by default; disabling is an explicit owner action).
 */

export type AutomationId =
  | "contact_alert" // #1 new enquiry → instant owner WhatsApp alert
  | "daily_digest" // #2 08:00 IST owner digest (arrivals/departures/dues/occupancy)
  | "review_request" // #3 post-checkout Google review request to the guest
  | "recovery_email" // #5 abandoned online-payment booking → one recovery email
  | "fb_auto_share" // #6 blog post published → Facebook page auto-share
  | "newsletter_welcome" // #7 newsletter subscribe → welcome email + owner heads-up
  | "blog_autopilot"; // #8 blog posts auto-generated + auto-published (events/trends/evergreen)

export type AutomationStatus = "ok" | "failed" | "skipped";

export interface AutomationLogEntry {
  id: string;
  at: string; // ISO timestamp
  automation: AutomationId;
  action: string; // short verb phrase, e.g. "owner alert", "digest", "review sweep"
  status: AutomationStatus;
  detail: string; // human-readable outcome (kept short)
}

export interface AutomationConfigEntry {
  enabled: boolean;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Config (on/off switches)
// ---------------------------------------------------------------------------

const CONFIG_KEY = "automation_config";

export async function readAutomationConfig(): Promise<Record<string, AutomationConfigEntry>> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: CONFIG_KEY } });
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Missing entry defaults to ENABLED. Never throws — a broken config row
 *  must never take a public form (contact/newsletter) down with it. */
export async function isAutomationEnabled(id: AutomationId): Promise<boolean> {
  try {
    const cfg = await readAutomationConfig();
    return cfg[id]?.enabled !== false;
  } catch {
    return true;
  }
}

export async function setAutomationEnabled(id: AutomationId, enabled: boolean): Promise<void> {
  const cfg = await readAutomationConfig();
  const next: Record<string, AutomationConfigEntry> = {
    ...cfg,
    [id]: { enabled, updatedAt: new Date().toISOString() },
  };
  await db.siteSetting.upsert({
    where: { key: CONFIG_KEY },
    create: {
      key: CONFIG_KEY,
      value: JSON.stringify(next),
      label: "Automation on/off switches (internal)",
      category: "automation",
    },
    update: { value: JSON.stringify(next) },
  });
}

// ---------------------------------------------------------------------------
// Activity log (monitoring)
// ---------------------------------------------------------------------------

const LOGS_KEY = "automation_logs";
const LOG_CAP = 200;

export async function logAutomation(
  automation: AutomationId,
  action: string,
  status: AutomationStatus,
  detail: string
): Promise<void> {
  try {
    const rows = await db.siteSetting.findMany({ where: { key: { in: [LOGS_KEY] } }, select: { key: true, value: true } });
    let logs: AutomationLogEntry[] = [];
    const raw = rows.find((r) => r.key === LOGS_KEY)?.value;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) logs = parsed;
    }
    const entry: AutomationLogEntry = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toISOString(),
      automation,
      action,
      status,
      detail: String(detail).slice(0, 300),
    };
    const next = [entry, ...logs].slice(0, LOG_CAP);
    await db.siteSetting.upsert({
      where: { key: LOGS_KEY },
      create: {
        key: LOGS_KEY,
        value: JSON.stringify(next),
        label: "Automation activity log (internal)",
        category: "automation",
      },
      update: { value: JSON.stringify(next) },
    });
  } catch (e) {
    // Logging must never break the automation it observes.
    console.error("[automation-manager] logAutomation failed:", e);
  }
}

export async function readAutomationLogs(limit = 100): Promise<AutomationLogEntry[]> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: LOGS_KEY } });
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, limit);
  } catch {
    return [];
  }
}

export async function clearAutomationLogs(): Promise<void> {
  await db.siteSetting.upsert({
    where: { key: LOGS_KEY },
    create: {
      key: LOGS_KEY,
      value: "[]",
      label: "Automation activity log (internal)",
      category: "automation",
    },
    update: { value: "[]" },
  });
}
