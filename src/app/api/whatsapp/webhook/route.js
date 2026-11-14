
import { createHmac, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Meta verification
export async function GET(request) {
  const url = new URL(request.url);

  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    process.env.WHATSAPP_VERIFY_TOKEN &&
    token === process.env.WHATSAPP_VERIFY_TOKEN &&
    challenge !== null
  ) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

// Incoming WhatsApp events
export async function POST(request) {
  const secret = process.env.META_APP_SECRET;
  const signature = request.headers.get("x-hub-signature-256");
  const rawBody = await request.text();

  if (!secret || !signature?.startsWith("sha256=")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const received = signature.slice(7);

  if (!/^[0-9a-f]{64}$/i.test(received)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (
    !timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(received, "hex")
    )
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const event = JSON.parse(rawBody);

  // Verified events can be sent to a queue or database
  // for processing in the next integration step.
  console.log("WhatsApp event received", {
    object: event.object,
    entries: event.entry?.length ?? 0
  });

  return new Response("EVENT_RECEIVED", { status: 200 });
}
