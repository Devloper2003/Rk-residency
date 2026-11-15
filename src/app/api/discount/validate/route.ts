import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const schema = z.object({
  code: z.string().min(1).max(30),
  email: z.string().email().max(160),
});

export async function POST(req: Request) {
  // Coupon codes are single-use secrets — without this gate an attacker can
  // brute-force the whole codespace (every other public endpoint that
  // accepts guesses — bookings, contact, newsletter — is already limited).
  // 10 tries/min/IP: a real guest retries a mistyped code a couple of
  // times; code-space enumeration at that pace is useless.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`coupon:${ip}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Please wait a minute." },
      { status: 429 }
    );
  }
  try {
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { code, email } = parsed.data;
    const now = new Date();

    const coupon = await db.discountCode.findUnique({
      where: { code: code.toUpperCase().trim() },
    });

    if (!coupon) {
      return NextResponse.json({ ok: false, error: "This coupon code does not exist." });
    }
    if (!coupon.isActive) {
      return NextResponse.json({ ok: false, error: "This coupon has been deactivated." });
    }
    if (coupon.usedAt) {
      return NextResponse.json({ ok: false, error: "This coupon has already been used." });
    }
    if (now < coupon.validFrom) {
      return NextResponse.json({ ok: false, error: "This coupon is not yet active." });
    }
    if (now > coupon.validUntil) {
      return NextResponse.json({ ok: false, error: "This coupon has expired." });
    }
    if (coupon.createdByGuest.toLowerCase() !== email.toLowerCase()) {
      return NextResponse.json({ ok: false, error: "This coupon is not valid for your email address." });
    }

    return NextResponse.json({
      ok: true,
      code: coupon.code,
      discountPct: coupon.discountPct,
      validUntil: coupon.validUntil,
    });
  } catch (e) {
    console.error("[/api/discount/validate] error:", e);
    return NextResponse.json({ error: "Validation failed." }, { status: 500 });
  }
}
