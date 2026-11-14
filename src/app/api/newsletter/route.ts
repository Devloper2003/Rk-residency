import { after, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { notifyOwnerWhatsApp } from "@/lib/booking-sync";
import { isAutomationEnabled, logAutomation } from "@/lib/automation-manager";
import { emailShell, sendGuestEmail, siteUrl } from "@/lib/guest-messages";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(160),
  name: z.string().max(120).optional(),
  language: z.enum(["en", "hi"]).default("en"),
});

export async function POST(req: Request) {
  // ✅ Rate limit INSIDE function, with proper ip extraction
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  if (!rateLimit(`newsletter:${ip}`, 5, 60_000)) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  try {
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid email address.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const existing = await db.newsletterSubscriber.findUnique({
      where: { email: parsed.data.email.toLowerCase() },
    });
    if (existing) {
      return NextResponse.json(
        { ok: true, alreadySubscribed: true, message: "You are already subscribed." },
        { status: 200 }
      );
    }

    const subscriber = await db.newsletterSubscriber.create({
      data: {
        email: parsed.data.email.toLowerCase(),
        name: parsed.data.name,
        language: parsed.data.language,
      },
    });

    // Automation (fire-and-forget via after() — survives the response on
    // serverless, never blocks or fails the subscription itself):
    //   1. owner heads-up on WhatsApp
    //   2. welcome email with the current active offer, if one is running
    //   Admin → Automations switch (newsletter_welcome) controls the whole
    //   block; off = silent skip so the subscription itself is unaffected.
    after(async () => {
      try {
        if (!(await isAutomationEnabled("newsletter_welcome"))) return;

        const ownerOk = await notifyOwnerWhatsApp(`*NEW SUBSCRIBER — RK Residency*\n${subscriber.email}`);
        console.log("[/api/newsletter] owner WhatsApp alert:", ownerOk ? "sent" : "skipped (gateway off or failed)");

        const now = new Date();
        const offer = await db.offer.findFirst({
          where: { validFrom: { lte: now }, validUntil: { gte: now } },
          orderBy: { createdAt: "desc" },
          select: { title: true, tagline: true, discountPct: true, slug: true },
        });
        const offerHtml = offer
          ? `<p style="margin:12px 0;padding:14px 18px;background:#ecfdf5;border-left:4px solid #0f766e;border-radius:8px;"><b>Current offer: ${offer.title}</b>${offer.discountPct ? ` — ${offer.discountPct}% off` : ""}<br/><span style="color:#475569;">${offer.tagline || ""}</span></p>`
          : "";
        const html = emailShell(
          "Welcome to the RK Residency family",
          `<p>Namaste${subscriber.name ? ` ${subscriber.name}` : ""},</p>` +
            `<p>Thank you for subscribing. Aap sabse pehle payenge humare Vrindavan stay deals, festival packages aur special offers — seedha aapke inbox me.</p>` +
            offerHtml +
            `<p>Tab tak ke liye, website par apni agli stay book kar sakte hain.</p>`,
          offer ? "Offer Dekhein" : "Rooms & Booking",
          offer ? `${siteUrl()}/offers` : `${siteUrl()}/`
        );
        const email = await sendGuestEmail(subscriber.email, "Welcome! RK Residency, Vrindavan", html);
        await logAutomation(
          "newsletter_welcome",
          `welcome email — ${subscriber.email}`,
          email.ok ? "ok" : "failed",
          email.ok
            ? `${subscriber.email} ko welcome email bheji${offer ? " (active offer ke saath)" : ""}`
            : `Send failed: ${email.error || "unknown"} — Resend config check karein`
        );
        console.log("[/api/newsletter] welcome email attempted for", subscriber.email);
      } catch (e) {
        console.error("[/api/newsletter] welcome email failed:", e);
      }
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[/api/newsletter] error:", e);
    return NextResponse.json({ error: "Subscription failed. Please try again." }, { status: 500 });
  }
}
