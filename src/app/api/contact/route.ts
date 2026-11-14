import { after, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { notifyOwnerWhatsApp } from "@/lib/booking-sync";
import { isAutomationEnabled, logAutomation } from "@/lib/automation-manager";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(160),
  phone: z.string().max(30).optional().or(z.literal("")),
  subject: z.string().min(2).max(200),
  message: z.string().min(5).max(4000),
  topic: z.enum(["GENERAL", "BOOKING", "EVENTS", "PRESS"]).default("GENERAL"),
});

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  if (!rateLimit(`contact:${ip}`, 5, 60_000)) {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
  }
  try {
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Please complete all required fields.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    await db.contactMessage.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email.toLowerCase(),
        phone: parsed.data.phone || null,
        subject: parsed.data.subject,
        message: parsed.data.message,
        topic: parsed.data.topic,
      },
    });

    const topicLabel: Record<string, string> = {
      GENERAL: "General",
      BOOKING: "Booking",
      EVENTS: "Event",
      PRESS: "Press",
    };
    const contactText =
      `*NEW ENQUIRY — RK Residency*\n` +
      `Name: ${parsed.data.name}\n` +
      `Phone: ${parsed.data.phone || "—"}\n` +
      `Email: ${parsed.data.email}\n` +
      `Topic: ${topicLabel[parsed.data.topic] || parsed.data.topic}\n` +
      `Subject: ${parsed.data.subject}\n` +
      `Message: ${parsed.data.message.slice(0, 300)}`;
    // Fire-and-forget via after(): the guest's response never depends on the
    // gateway, but the alert still survives the response on serverless.
    // Admin → Automations switch controls it (silent skip when off).
    after(async () => {
      try {
        if (!(await isAutomationEnabled("contact_alert"))) return;
        const ok = await notifyOwnerWhatsApp(contactText);
        await logAutomation(
          "contact_alert",
          `enquiry alert — ${parsed.data.name}`,
          ok ? "ok" : "failed",
          ok
            ? `${parsed.data.name} ki enquiry owner WhatsApp par pahunchi (${parsed.data.phone || parsed.data.email})`
            : "Gateway off/failed — Admin → Payment Settings → WhatsApp Notifications check karein"
        );
        console.log("[/api/contact] owner WhatsApp alert:", ok ? "sent" : "skipped (gateway off or failed)");
      } catch (e) {
        console.error("[/api/contact] owner alert failed:", e);
      }
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[/api/contact] error:", e);
    return NextResponse.json({ error: "Failed to send message. Please try again." }, { status: 500 });
  }
}
