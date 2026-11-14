"use client";

/**
 * AutomationsTab — Admin → Automations.
 *
 * One panel to MANAGE (on/off switch), EXECUTE ("Run now") and MONITOR
 * (live activity log) the 6 website automations. Reads/writes through
 * /api/admin/automations — no schema changes, config + logs live in
 * SiteSetting JSON rows.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Bell, BarChart3, Star, MailWarning, Facebook, Mail, Zap, Play,
  Loader2, RefreshCw, Trash2, CheckCircle2, XCircle, MinusCircle,
  AlertTriangle, PowerOff, ShieldAlert, Workflow, Newspaper,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { adminFetch, LoadingSpinner, ErrorState } from "./_shared";
import { toast } from "sonner";

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  channel: string;
  enabled: boolean;
  ready: boolean;
  readyHint: string;
  lastRun?: { at: string; status: string; action: string; detail: string };
  count?: string;
  mode?: "auto_drip" | "instant" | "draft_only";
}

interface LogEntry {
  id: string;
  at: string;
  automation: string;
  action: string;
  status: "ok" | "failed" | "skipped";
  detail: string;
}

interface Payload {
  automations: CatalogItem[];
  logs: LogEntry[];
  summary: { total: number; enabled: number; ready: number; lastActivityAt: string | null };
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  contact_alert: Bell,
  daily_digest: BarChart3,
  review_request: Star,
  recovery_email: MailWarning,
  fb_auto_share: Facebook,
  newsletter_welcome: Mail,
  blog_autopilot: Newspaper,
};

const AUTO_LABEL: Record<string, string> = {
  contact_alert: "Contact Alert",
  daily_digest: "Daily Digest",
  review_request: "Review Request",
  recovery_email: "Recovery Email",
  fb_auto_share: "FB Auto-Share",
  newsletter_welcome: "Welcome Email",
  blog_autopilot: "Blog Autopilot",
};

const MODE_LABEL: Record<string, string> = {
  auto_drip: "Auto: drip schedule + publish (recommended)",
  instant: "Auto: publish instantly",
  draft_only: "Sirf drafts — review ke baad main publish karunga",
};

function fmtIST(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
}

function StatusChip({ status }: { status: string }) {
  if (status === "ok")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-teal/10 px-2 py-0.5 font-display text-[10px] font-semibold text-teal">
        <CheckCircle2 className="h-3 w-3" /> OK
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-marsala/10 px-2 py-0.5 font-display text-[10px] font-semibold text-marsala">
        <XCircle className="h-3 w-3" /> FAILED
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-charcoal/10 px-2 py-0.5 font-display text-[10px] font-semibold text-charcoal-soft">
      <MinusCircle className="h-3 w-3" /> SKIPPED
    </span>
  );
}

function Toggle({ on, disabled, onClick }: { on: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-teal" : "bg-charcoal/25"
      }`}
      aria-label={on ? "Automation on — click to turn off" : "Automation off — click to turn on"}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`}
      />
    </button>
  );
}

export function AutomationsTab() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [clearing, setClearing] = useState(false);
  const [savingMode, setSavingMode] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminFetch<Payload>("/api/admin/automations");
      if (res === null) return; // 401 → session cleared by adminFetch
      setError(null);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (item: CatalogItem) => {
    setTogglingId(item.id);
    try {
      const res = await adminFetch<{ ok: boolean }>("/api/admin/automations", {
        method: "POST",
        body: JSON.stringify({ action: "toggle", automation: item.id, enabled: !item.enabled }),
      });
      if (res) toast.success(`${AUTO_LABEL[item.id]} ${item.enabled ? "OFF kar diya" : "ON kar diya"}`);
    } catch (e) {
      toast.error("Toggle fail", { description: e instanceof Error ? e.message : "Please try again" });
    } finally {
      setTogglingId(null);
      load();
    }
  };

  const runNow = async (item: CatalogItem) => {
    setBusyId(item.id);
    try {
      const res = await adminFetch<{ ok: boolean; detail: string }>("/api/admin/automations", {
        method: "POST",
        body: JSON.stringify({ action: "run", automation: item.id }),
      });
      if (res) {
        if (res.ok) toast.success(res.detail);
        else toast.warning(res.detail || "Automation ne kaam poora nahi kiya");
      }
    } catch (e) {
      toast.error("Run fail", { description: e instanceof Error ? e.message : "Please try again" });
    } finally {
      setBusyId(null);
      load();
    }
  };

  const clearLogs = async () => {
    if (!confirm("Saari automation activity log clear kar dein? (Automations khud ON rahenge)")) return;
    setClearing(true);
    try {
      const res = await adminFetch<{ ok: boolean }>("/api/admin/automations", {
        method: "POST",
        body: JSON.stringify({ action: "clear_logs" }),
      });
      if (res) toast.success("Activity log clear ho gayi");
    } catch (e) {
      toast.error("Clear fail", { description: e instanceof Error ? e.message : "" });
    } finally {
      setClearing(false);
      load();
    }
  };

  const setMode = async (item: CatalogItem, mode: string) => {
    setSavingMode(true);
    try {
      const res = await adminFetch<{ ok: boolean }>("/api/admin/automations", {
        method: "POST",
        body: JSON.stringify({ action: "config", automation: "blog_autopilot", mode }),
      });
      if (res) toast.success(`Blog Autopilot mode: ${MODE_LABEL[mode]?.split(" ").slice(0, 3).join(" ") || mode}`);
    } catch (e) {
      toast.error("Mode save fail", { description: e instanceof Error ? e.message : "Please try again" });
    } finally {
      setSavingMode(false);
      load();
    }
  };

  if (!data && !error) return <LoadingSpinner />;
  if (error && !data) return <ErrorState title="Automations load nahi hui" message={error} onRetry={load} />;

  const logs = (data?.logs || []).filter((l) => filter === "all" || l.automation === filter);

  return (
    <div className="space-y-6">
      {/* Summary strip */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-full border border-teal/20 bg-teal/5 px-4 py-1.5 font-display text-xs text-teal">
          <Zap className="h-3.5 w-3.5" />
          {data?.summary.enabled ?? 0}/{data?.summary.total ?? 7} automations ON
        </div>
        <div className="flex items-center gap-2 rounded-full border border-charcoal/15 bg-charcoal/5 px-4 py-1.5 font-display text-xs text-charcoal-soft">
          <Workflow className="h-3.5 w-3.5" />
          {data?.summary.ready ?? 0}/{data?.summary.total ?? 7} setup complete
        </div>
        {data?.summary.lastActivityAt && (
          <div className="font-display text-[11px] text-charcoal-soft">
            Last activity: {fmtIST(data.summary.lastActivityAt)}
          </div>
        )}
        <Button onClick={load} variant="outline" size="sm" className="ml-auto rounded-lg border-charcoal/15 text-charcoal-soft hover:border-teal/40 hover:text-teal">
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      {/* Automation cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {(data?.automations || []).map((item) => {
          const Icon = ICONS[item.id] || Zap;
          return (
            <div
              key={item.id}
              className={`rounded-2xl border bg-white p-5 shadow-sm transition-opacity ${item.enabled ? "border-charcoal/10" : "border-charcoal/10 opacity-70"}`}
            >
              <div className="flex items-start gap-3">
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${item.enabled ? "bg-teal/10 text-teal" : "bg-charcoal/10 text-charcoal-soft"}`}>
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-serif text-base font-semibold text-charcoal">{item.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-wider ${
                      item.enabled ? "bg-teal/10 text-teal" : "bg-charcoal/10 text-charcoal-soft"
                    }`}>
                      {item.enabled ? "ON" : "OFF"}
                    </span>
                  </div>
                  <p className="mt-1 font-display text-xs leading-relaxed text-charcoal-soft">{item.description}</p>
                  <p className="mt-1 font-display text-[10px] uppercase tracking-wider text-charcoal-soft/70">{item.channel}{item.count ? ` · ${item.count}` : ""}</p>
                </div>
                <Toggle on={item.enabled} disabled={togglingId === item.id} onClick={() => toggle(item)} />
              </div>

              {/* readiness / setup hint */}
              {!item.ready ? (
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-gold/30 bg-gold/5 px-3 py-2">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" />
                  <p className="font-display text-[11px] leading-relaxed text-charcoal">
                    <span className="font-semibold">Setup needed:</span> {item.readyHint}
                  </p>
                </div>
              ) : item.lastRun ? (
                <div className="mt-3 rounded-xl bg-ivory-deep/50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-[10px] uppercase tracking-wider text-charcoal-soft">
                      Last run · {fmtIST(item.lastRun.at)}
                    </span>
                    <StatusChip status={item.lastRun.status} />
                  </div>
                  <p className="mt-1 line-clamp-2 font-display text-[11px] leading-relaxed text-charcoal-soft">
                    {item.lastRun.detail}
                  </p>
                </div>
              ) : (
                <div className="mt-3 rounded-xl bg-ivory-deep/50 px-3 py-2 font-display text-[11px] text-charcoal-soft">
                  Abhi tak run nahi hui — pehli event/cron par chalegi
                </div>
              )}

              <div className="mt-3 flex items-center gap-2">
                <Button
                  onClick={() => runNow(item)}
                  disabled={busyId === item.id}
                  size="sm"
                  className="rounded-full bg-teal font-display text-xs font-semibold text-ivory hover:bg-teal-deep disabled:opacity-50"
                >
                  {busyId === item.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                  Run now
                </Button>
                <span className="font-display text-[10px] text-charcoal-soft/70">
                  {item.id === "daily_digest" && "force re-send · din ka marker bypass"}
                  {item.id === "review_request" && "kal ke checkouts ko request"}
                  {item.id === "recovery_email" && "48h window scan"}
                  {item.id === "fb_auto_share" && "agla unshared post share"}
                  {item.id === "contact_alert" && "aapko test alert"}
                  {item.id === "newsletter_welcome" && "aapko test email"}
                  {item.id === "blog_autopilot" && "agla pending post generate + publish"}
                </span>
              </div>

              {/* Blog Autopilot — publish mode selector */}
              {item.id === "blog_autopilot" && (
                <div className="mt-3 rounded-xl border border-charcoal/10 bg-ivory-deep/40 px-3 py-2.5">
                  <label className="mb-1.5 block font-display text-[10px] font-semibold uppercase tracking-wider text-charcoal-soft">
                    Publish mode
                  </label>
                  <select
                    value={item.mode || "auto_drip"}
                    onChange={(e) => setMode(item, e.target.value)}
                    disabled={savingMode}
                    className="w-full rounded-lg border border-charcoal/15 bg-white px-2.5 py-1.5 font-display text-xs text-charcoal outline-none focus:border-teal/40 disabled:opacity-50"
                    aria-label="Blog autopilot publish mode"
                  >
                    {Object.entries(MODE_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  <p className="mt-1.5 font-display text-[10px] leading-relaxed text-charcoal-soft/80">
                    {item.mode === "instant"
                      ? "Post generate hote hi live + FB share — turant traffic chahiye toh ye choose karein."
                      : item.mode === "draft_only"
                        ? "Kuch bhi auto-publish nahi hoga — har post aapke review ke liye drafts me aayegi."
                        : "Recommended: har post ~3 din ke gap par auto-schedule hota hai — blog + FB dono par steady engagement."}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Activity log */}
      <div className="rounded-2xl border border-charcoal/10 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b border-charcoal/10 px-5 py-4">
          <h3 className="font-serif text-base font-semibold text-charcoal">Activity Log</h3>
          <span className="rounded-full bg-charcoal/10 px-2 py-0.5 font-display text-[10px] font-semibold text-charcoal-soft">
            {logs.length} entries
          </span>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="ml-auto rounded-lg border border-charcoal/15 bg-white px-2.5 py-1.5 font-display text-xs text-charcoal outline-none focus:border-teal/40"
            aria-label="Filter log by automation"
          >
            <option value="all">Sab automations</option>
            {Object.entries(AUTO_LABEL).map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
          <Button onClick={clearLogs} disabled={clearing} variant="outline" size="sm" className="rounded-lg border-marsala/30 text-marsala hover:bg-marsala/5">
            {clearing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />} Clear
          </Button>
        </div>
        {logs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
            <PowerOff className="h-6 w-6 text-charcoal/20" />
            <p className="font-display text-xs text-charcoal-soft">
              Koi activity nahi — automations chalte hi entries yahan dikheingi (har send, failure aur skip)
            </p>
          </div>
        ) : (
          <div className="divide-y divide-charcoal/5">
            {logs.slice(0, 60).map((l) => (
              <div key={l.id} className="flex items-start gap-3 px-5 py-2.5">
                <span className="w-32 shrink-0 font-display text-[10px] text-charcoal-soft/80">{fmtIST(l.at)}</span>
                <span className="w-28 shrink-0 font-display text-[11px] font-semibold text-charcoal">{AUTO_LABEL[l.automation] || l.automation}</span>
                <span className="hidden w-40 shrink-0 truncate font-display text-[11px] text-charcoal-soft sm:block">{l.action}</span>
                <span className="shrink-0"><StatusChip status={l.status} /></span>
                <span className="min-w-0 flex-1 font-display text-[11px] leading-relaxed text-charcoal-soft">{l.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
