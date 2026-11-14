"use client";

/**
 * EmailMarketingTab — Admin → Email Marketing (dedicated bulk sender).
 *
 * Bulk email campaigns ko serverless-safe batches me bhejta hai:
 *   start (audience resolve, ≤500) → send_batch ×N (25/batch, live progress)
 *   → finalize. History SiteSetting JSON me, sends via the site's existing
 *   Resend account. Small transactional campaigns stay in Marketing Hub —
 *   ye tab pure bulk marketing ke liye hai.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Users, Send, Loader2, RefreshCw, Mail, CheckCircle2, XCircle,
  History, Info, UserPlus, Eye, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adminFetch, LoadingSpinner, ErrorState } from "./_shared";
import { toast } from "sonner";

interface Payload {
  emailConfigured: boolean;
  fromEmail: string;
  counts: { subscribers: number; subscribersEn: number; subscribersHi: number; guests: number; all: number };
  recentSubscribers: { email: string; name: string | null; language: string; createdAt: string }[];
  campaigns: {
    id: string; at: string; subject: string; audience: string;
    total: number; sent: number; failed: number; status: string; by: string; sampleErrors?: string[];
  }[];
}

type Audience = "subscribers" | "guests" | "all" | "custom";

const AUDIENCES: { id: Audience; label: string; desc: string }[] = [
  { id: "subscribers", label: "Newsletter Subscribers", desc: "Website par subscribe karne wale sab log" },
  { id: "guests", label: "Past Guests", desc: "Booking kar chuke guests (cancelled nahi) — repeat-stay offers ke liye best" },
  { id: "all", label: "Sab (Subscribers + Guests)", desc: "Dono lists ka merged, duplicate-free list" },
  { id: "custom", label: "Custom List", desc: "Khud apni list paste karein (comma/newline separated)" },
];

const TEMPLATES = [
  {
    name: "Offer blast",
    subject: "Special Offer — RK Residency Vrindavan mein apna stay book karein",
    message:
      "Namaste!\n\nIs month RK Residency mein direct booking par special rates available hain — comfortable rooms, mandiron ke paas, aur sattvik breakfast ke saath.\n\nRooms limited hain, jaldi book karein aur best price payein.\n\nDhanyavaad,\nTeam RK Residency",
    ctaLabel: "Abhi Book Karein",
    ctaUrl: "https://www.rkresidencyvrindavan.in/rooms",
  },
  {
    name: "Festival invite",
    subject: "Braj ke utsav — RK Residency mein swagat hai",
    message:
      "Vrindavan ke festival season mein aapka swagat hai!\n\nMandiron ke darshan, Yamuna aarti aur Braj ka apna mahaul — sab kuch paas mein. Festival dates mein rooms jaldi full ho jate hain.\n\nAaj hi apna room reserve karein.\n\nRadhe Radhe,\nTeam RK Residency",
    ctaLabel: "Rooms Dekhein",
    ctaUrl: "https://www.rkresidencyvrindavan.in/rooms",
  },
  {
    name: "Weekend deal",
    subject: "Weekend Vrindavan plan? Best rates yahin milenge",
    message:
      "Weekend getaway ka plan bana rahe hain?\n\nRK Residency mein comfortable AC rooms, hot water, room service — aur mandiron se sirf kuch minute. Weekend ke liye abhi book karein.\n\nHum aapki seva ka intezaar karenge.\n\nTeam RK Residency",
    ctaLabel: "Booking Karein",
    ctaUrl: "https://www.rkresidencyvrindavan.in/rooms",
  },
];

const BATCH_SIZE = 25;

function fmtIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
}

export function EmailMarketingTab() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audience, setAudience] = useState<Audience>("subscribers");
  const [language, setLanguage] = useState<"all" | "en" | "hi">("all");
  const [customEmails, setCustomEmails] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [ctaLabel, setCtaLabel] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; sent: number; failed: number } | null>(null);
  const [testing, setTesting] = useState(false);
  const [showSubs, setShowSubs] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminFetch<Payload>("/api/admin/marketing/bulk-email");
      if (res === null) return;
      setError(null);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const audienceCount = (): number => {
    if (!data) return 0;
    if (audience === "custom") {
      const list = customEmails.split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s));
      return new Set(list).size;
    }
    if (audience === "subscribers") return language === "all" ? data.counts.subscribers : language === "en" ? data.counts.subscribersEn : data.counts.subscribersHi;
    if (audience === "guests") return data.counts.guests;
    return data.counts.all;
  };

  const canSend = data?.emailConfigured && subject.trim().length >= 3 && message.trim().length >= 10;

  const applyTemplate = (t: (typeof TEMPLATES)[number]) => {
    setSubject(t.subject);
    setMessage(t.message);
    setCtaLabel(t.ctaLabel);
    setCtaUrl(t.ctaUrl);
    toast.success(`"${t.name}" template load ho gaya`);
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await adminFetch<{ ok: boolean; testedTo: string }>("/api/admin/marketing/bulk-email", {
        method: "POST",
        body: JSON.stringify({ action: "test", subject, message, ctaLabel, ctaUrl }),
      });
      if (res) toast.success(`Test email ${res.testedTo} par bhej diya — inbox check karein`);
    } catch (e) {
      toast.error("Test email fail", { description: e instanceof Error ? e.message : "" });
    } finally {
      setTesting(false);
    }
  };

  const sendBulk = async () => {
    const count = audienceCount();
    if (count === 0) {
      toast.error("Is audience me koi valid email nahi hai");
      return;
    }
    if (!confirm(`Ye campaign ${count} logon ko jayega. Confirm hai? (Emails batch-by-batch jayenge, progress bar dikhega)`)) return;

    setSending(true);
    setProgress({ done: 0, total: count, sent: 0, failed: 0 });
    try {
      const start = await adminFetch<{ ok: boolean; campaignId: string; total: number; recipients: string[] }>(
        "/api/admin/marketing/bulk-email",
        {
          method: "POST",
          body: JSON.stringify({
            action: "start",
            subject,
            message,
            ctaLabel,
            ctaUrl,
            audience,
            language,
            customEmails: customEmails,
          }),
        }
      );
      if (!start) throw new Error("Session expired — dobara login karein");

      const recipients = start.recipients;
      let sent = 0;
      let failed = 0;
      let done = 0;
      for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);
        const res = await adminFetch<{ ok: boolean; sent: number; failed: number }>(
          "/api/admin/marketing/bulk-email",
          {
            method: "POST",
            body: JSON.stringify({ action: "send_batch", campaignId: start.campaignId, emails: batch }),
          }
        );
        // One failed batch (network blip) must not kill the whole campaign —
        // count the remainder as failed and keep going.
        const bSent = res?.sent ?? 0;
        const bFailed = res ? res.failed : batch.length;
        sent += bSent;
        failed += bFailed;
        done += batch.length;
        setProgress({ done, total: recipients.length, sent, failed });
      }

      const fin = await adminFetch<{ ok: boolean; sent: number; failed: number }>(
        "/api/admin/marketing/bulk-email",
        { method: "POST", body: JSON.stringify({ action: "finalize", campaignId: start.campaignId }) }
      );
      const finalSent = fin?.sent ?? sent;
      const finalFailed = fin?.failed ?? failed;
      toast.success(`Campaign poora hua — ${finalSent} sent, ${finalFailed} failed (${recipients.length} total)`);
      setProgress(null);
      setSubject("");
      setMessage("");
      setCtaLabel("");
      setCtaUrl("");
      load();
    } catch (e) {
      toast.error("Campaign fail", { description: e instanceof Error ? e.message : "" });
      setProgress(null);
      load();
    } finally {
      setSending(false);
    }
  };

  if (!data && !error) return <LoadingSpinner />;
  if (error && !data) return <ErrorState title="Email Marketing load nahi hua" message={error} onRetry={load} />;

  return (
    <div className="space-y-6">
      {/* Config banner */}
      {!data?.emailConfigured ? (
        <div className="flex items-start gap-3 rounded-2xl border border-marsala/30 bg-marsala/5 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-marsala" />
          <p className="font-display text-xs leading-relaxed text-charcoal">
            <span className="font-semibold">Resend configured nahi hai.</span> Bulk send ke liye Site Settings me{" "}
            <code className="rounded bg-charcoal/10 px-1 font-mono text-[10px]">email_api_key</code> save karein — wahi
            account booking confirmations use karta hai.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-2xl border border-teal/20 bg-teal/5 px-4 py-3">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-teal" />
          <p className="font-display text-xs text-charcoal">
            Resend ready — campaigns <span className="font-semibold text-teal">{data.fromEmail}</span> se jayenge
          </p>
        </div>
      )}

      {/* Audience stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { icon: Mail, label: "Subscribers", value: data?.counts.subscribers ?? 0 },
          { icon: UserPlus, label: "Past Guests", value: data?.counts.guests ?? 0 },
          { icon: Users, label: "Total Reach", value: data?.counts.all ?? 0 },
          { icon: History, label: "Campaigns", value: data?.campaigns.length ?? 0 },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-charcoal/10 bg-white px-4 py-3 shadow-sm">
            <s.icon className="h-4 w-4 text-teal" />
            <div className="mt-1.5 font-serif text-xl font-bold text-charcoal">{s.value}</div>
            <div className="font-display text-[10px] uppercase tracking-wider text-charcoal-soft">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Composer */}
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          {/* Audience */}
          <div className="rounded-2xl border border-charcoal/10 bg-white p-5 shadow-sm">
            <h3 className="font-serif text-base font-semibold text-charcoal">1. Audience chunein</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {AUDIENCES.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setAudience(a.id)}
                  disabled={sending}
                  className={`rounded-xl border px-3.5 py-3 text-left transition-all disabled:opacity-50 ${
                    audience === a.id ? "border-teal bg-teal/5 ring-1 ring-teal/30" : "border-charcoal/15 bg-white hover:border-teal/40"
                  }`}
                >
                  <div className="font-display text-xs font-semibold text-charcoal">{a.label}</div>
                  <div className="mt-0.5 font-display text-[10px] leading-relaxed text-charcoal-soft">{a.desc}</div>
                </button>
              ))}
            </div>

            {audience !== "custom" && (
              <div className="mt-3 flex items-center gap-3">
                <Label className="font-display text-[10px] uppercase tracking-wider text-charcoal-soft">Language</Label>
                {(["all", "en", "hi"] as const).map((l) => (
                  <button
                    key={l}
                    onClick={() => setLanguage(l)}
                    disabled={sending}
                    className={`rounded-full px-3 py-1 font-display text-[11px] transition-colors disabled:opacity-40 ${
                      language === l ? "bg-teal text-ivory" : "bg-charcoal/10 text-charcoal-soft hover:bg-charcoal/15"
                    }`}
                  >
                    {l === "all" ? "Sab" : l === "en" ? "English" : "Hindi"}
                  </button>
                ))}
              </div>
            )}

            {audience === "custom" && (
              <textarea
                value={customEmails}
                onChange={(e) => setCustomEmails(e.target.value)}
                disabled={sending}
                rows={5}
                placeholder={"guest1@example.com, guest2@example.com\nguest3@example.com"}
                className="mt-3 w-full rounded-xl border border-charcoal/15 bg-ivory-deep/30 px-3 py-2.5 font-mono text-xs text-charcoal outline-none focus:border-teal/40 disabled:opacity-50"
              />
            )}

            <div className="mt-3 flex items-center gap-2 rounded-xl bg-ivory-deep/50 px-3 py-2">
              <Info className="h-3.5 w-3.5 shrink-0 text-teal" />
              <p className="font-display text-[11px] text-charcoal-soft">
                Is audience me <span className="font-bold text-teal">{audienceCount()}</span> valid emails hain
                (maximum 500 per campaign, duplicates auto-remove)
              </p>
            </div>
          </div>

          {/* Compose */}
          <div className="rounded-2xl border border-charcoal/10 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="font-serif text-base font-semibold text-charcoal">2. Email likhein</h3>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => applyTemplate(t)}
                    disabled={sending}
                    className="rounded-full border border-teal/25 bg-teal/5 px-2.5 py-1 font-display text-[10px] font-semibold text-teal hover:bg-teal/10 disabled:opacity-40"
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 space-y-3">
              <div>
                <Label className="mb-1 block font-display text-[10px] uppercase tracking-wider text-charcoal-soft">Subject</Label>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={sending} maxLength={150} placeholder="Special Offer — RK Residency Vrindavan" className="bg-ivory-deep/30" />
              </div>
              <div>
                <Label className="mb-1 block font-display text-[10px] uppercase tracking-wider text-charcoal-soft">
                  Message (khaali line se naya paragraph)
                </Label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  disabled={sending}
                  rows={8}
                  maxLength={5000}
                  placeholder="Namaste! ..."
                  className="w-full rounded-xl border border-charcoal/15 bg-ivory-deep/30 px-3 py-2.5 font-display text-sm leading-relaxed text-charcoal outline-none focus:border-teal/40 disabled:opacity-50"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="mb-1 block font-display text-[10px] uppercase tracking-wider text-charcoal-soft">CTA Button Text (optional)</Label>
                  <Input value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} disabled={sending} maxLength={60} placeholder="Abhi Book Karein" className="bg-ivory-deep/30" />
                </div>
                <div>
                  <Label className="mb-1 block font-display text-[10px] uppercase tracking-wider text-charcoal-soft">CTA Link (optional)</Label>
                  <Input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} disabled={sending} placeholder="https://www.rkresidencyvrindavan.in/rooms" className="bg-ivory-deep/30" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Preview + send */}
        <div className="space-y-5 lg:col-span-2">
          <div className="rounded-2xl border border-charcoal/10 bg-white p-5 shadow-sm">
            <h3 className="flex items-center gap-2 font-serif text-base font-semibold text-charcoal">
              <Eye className="h-4 w-4 text-teal" /> Preview
            </h3>
            <div className="mt-3 overflow-hidden rounded-xl border border-charcoal/10">
              <div className="border-b-2 border-[#C9A227] bg-[#faf6ee] px-4 py-3 text-center">
                <div className="font-serif text-lg font-bold text-[#1D5B45]">RK Residency</div>
                <div className="font-display text-[8px] uppercase tracking-[3px] text-[#8a8577]">Vrindavan</div>
              </div>
              <div className="bg-[#faf6ee] px-4 py-4">
                {subject ? (
                  <p className="mb-2 font-display text-xs font-bold text-[#1D5B45]">{subject}</p>
                ) : (
                  <p className="mb-2 font-display text-xs italic text-charcoal-soft/60">Subject yahan dikhega…</p>
                )}
                <div className="max-h-52 overflow-y-auto">
                  {message
                    ? message.split(/\n{2,}/).filter((p) => p.trim()).map((p, i) => (
                        <p key={i} className="mb-2 whitespace-pre-line font-display text-[11px] leading-relaxed text-[#3d3a34]">{p}</p>
                      ))
                    : <p className="font-display text-[11px] italic text-charcoal-soft/60">Message yahan dikhega…</p>}
                  {ctaLabel && ctaUrl && (
                    <span className="mt-2 inline-block rounded-full bg-[#1D5B45] px-4 py-2 font-display text-[11px] font-semibold text-white">{ctaLabel}</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Send actions */}
          <div className="rounded-2xl border border-charcoal/10 bg-white p-5 shadow-sm">
            <h3 className="font-serif text-base font-semibold text-charcoal">3. Bhejein</h3>
            {progress ? (
              <div className="mt-3">
                <div className="flex items-center justify-between font-display text-xs text-charcoal">
                  <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin text-teal" /> Sending…</span>
                  <span>{progress.done}/{progress.total}</span>
                </div>
                <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-charcoal/10">
                  <div
                    className="h-full rounded-full bg-teal transition-all"
                    style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
                  />
                </div>
                <div className="mt-2 flex gap-3 font-display text-[11px]">
                  <span className="text-teal">{progress.sent} sent</span>
                  {progress.failed > 0 && <span className="text-marsala">{progress.failed} failed</span>}
                </div>
                <p className="mt-2 font-display text-[10px] leading-relaxed text-charcoal-soft">
                  Tab khol kar rakhein — batches khud aage badhte hain. Beech me band bhi kar sakte hain, jitne emails gaye wo count ho chuke honge.
                </p>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                <Button
                  onClick={sendTest}
                  disabled={!canSend || testing || !data?.emailConfigured}
                  variant="outline"
                  className="w-full rounded-full border-teal/30 font-display text-xs font-semibold text-teal hover:bg-teal/5 disabled:opacity-40"
                >
                  {testing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Mail className="mr-2 h-3.5 w-3.5" />}
                  Test email khud ko bhejein
                </Button>
                <Button
                  onClick={sendBulk}
                  disabled={!canSend || sending || !data?.emailConfigured}
                  className="w-full rounded-full bg-teal font-display text-xs font-semibold text-ivory hover:bg-teal-deep disabled:opacity-40"
                >
                  {sending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-2 h-3.5 w-3.5" />}
                  Bulk send — {audienceCount()} logon ko
                </Button>
                <p className="font-display text-[10px] leading-relaxed text-charcoal-soft">
                  Tip: pehle TEST bhej kar preview dekhein, phir bulk send. Resend ke free plan me daily limit ho sakti hai —
                  failed emails history me dikheinge.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Campaign history */}
      <div className="rounded-2xl border border-charcoal/10 bg-white shadow-sm">
        <div className="flex items-center gap-3 border-b border-charcoal/10 px-5 py-4">
          <h3 className="font-serif text-base font-semibold text-charcoal">Campaign History</h3>
          <Button onClick={load} variant="outline" size="sm" className="ml-auto rounded-lg border-charcoal/15 text-charcoal-soft hover:border-teal/40 hover:text-teal">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
        {!data?.campaigns.length ? (
          <div className="px-5 py-8 text-center font-display text-xs text-charcoal-soft">
            Abhi tak koi bulk campaign nahi bheja gaya
          </div>
        ) : (
          <div className="divide-y divide-charcoal/5">
            {data.campaigns.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <span className="w-28 shrink-0 font-display text-[10px] text-charcoal-soft">{fmtIST(c.at)}</span>
                <span className="min-w-0 flex-1 truncate font-display text-xs font-semibold text-charcoal">{c.subject}</span>
                <span className="rounded-full bg-charcoal/10 px-2 py-0.5 font-display text-[10px] text-charcoal-soft">{c.audience}</span>
                <span className="font-display text-[11px] text-teal">{c.sent}/{c.total} sent</span>
                {c.failed > 0 && <span className="font-display text-[11px] text-marsala">{c.failed} failed</span>}
                <span className={`rounded-full px-2 py-0.5 font-display text-[9px] font-bold uppercase ${
                  c.status === "completed" ? "bg-teal/10 text-teal" : "bg-gold/15 text-charcoal"
                }`}>
                  {c.status === "completed" ? "Done" : "In progress"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent subscribers */}
      <div className="rounded-2xl border border-charcoal/10 bg-white shadow-sm">
        <button
          onClick={() => setShowSubs((s) => !s)}
          className="flex w-full items-center gap-2 px-5 py-4 text-left"
        >
          <Mail className="h-4 w-4 text-teal" />
          <h3 className="font-serif text-base font-semibold text-charcoal">Recent Subscribers</h3>
          <span className="rounded-full bg-charcoal/10 px-2 py-0.5 font-display text-[10px] font-semibold text-charcoal-soft">
            {data?.counts.subscribers ?? 0} total
          </span>
          <span className={`ml-auto font-display text-[10px] text-charcoal-soft ${showSubs ? "" : "rotate-180"}`} aria-hidden>▲</span>
        </button>
        {showSubs && (
          <div className="border-t border-charcoal/5 px-5 pb-4">
            {!data?.recentSubscribers.length ? (
              <p className="py-4 font-display text-xs text-charcoal-soft">Koi subscriber nahi hai</p>
            ) : (
              <div className="divide-y divide-charcoal/5">
                {data.recentSubscribers.map((s) => (
                  <div key={s.email} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate font-display text-xs text-charcoal">{s.email}</span>
                    {s.name && <span className="font-display text-[11px] text-charcoal-soft">{s.name}</span>}
                    <span className="rounded-full bg-charcoal/10 px-2 py-0.5 font-display text-[9px] uppercase text-charcoal-soft">{s.language}</span>
                    <span className="font-display text-[10px] text-charcoal-soft/70">{fmtIST(s.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
