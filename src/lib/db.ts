import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

/**
 * db.ts — Prisma client over the pg driver adapter, Workers-safe.
 *
 * Why the adapter: the site runs on Cloudflare Workers (workerd via OpenNext).
 * Workers cannot execute Prisma's compiled Rust query engine binary, but they
 * DO run the pg driver adapter (plain postgres wire protocol over
 * nodejs_compat TCP). The adapter works identically on Node, so one codebase
 * serves both platforms.
 *
 * WHY NOT A SINGLE GLOBAL CLIENT (the old Vercel pattern):
 * Cloudflare Workers suspend/evict isolates between requests. When that
 * happens, the sockets inside a long-lived pg Pool die silently. The next
 * request that reuses the cached global client then either
 *   - throws instantly (fast 500 in ~100 ms), or
 *   - hangs until some socket timeout (slow 500 after 10-30 s), or
 *   - succeeds if the isolate happens to be fresh (slow 200 after cold start).
 * That is exactly the intermittent "mostly pages 500 / analytics unable to
 * load" behaviour observed after the Cloudflare migration.
 *
 * THE FIX — burst-scoped clients:
 * A fresh PrismaClient (and its own 1-2 socket Pool) is created per "burst".
 * A burst is a sliding 25 s window of activity: continuous traffic keeps one
 * healthy client (sockets stay alive while the isolate is awake and serving),
 * and after >25 s of quiet the next request transparently gets a brand-new
 * client with brand-new sockets. Call sites keep importing `db` as before —
 * `db` is a Proxy that resolves every property access against the current
 * burst's client, so no call site had to change (81 files use it).
 *
 * Pool tuning: tiny pool (max 2), 10 s connect timeout (fail fast instead of
 * hanging a whole render), 15 s idle timeout (Neon's pooler closes idle
 * connections anyway).
 */

function makeClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL || ''
  const adapter = new PrismaPg({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 15_000,
  })
  return new PrismaClient({ adapter })
}

const gBurst = globalThis as unknown as {
  __RK_DB_BURST__?: { client: PrismaClient; stamp: number }
}

const BURST_TTL_MS = 25_000

/** Returns the current burst's healthy PrismaClient (creates one if stale). */
export function getDb(): PrismaClient {
  const now = Date.now()
  const burst = gBurst.__RK_DB_BURST__
  if (burst && now - burst.stamp < BURST_TTL_MS) {
    burst.stamp = now // sliding window — continuous traffic reuses one client
    return burst.client
  }
  const client = makeClient()
  gBurst.__RK_DB_BURST__ = { client, stamp: now }
  runLegacyBackfill(client)
  return client
}

/**
 * One-time per-process backfill: bookings created before the downloadToken
 * column shipped have a NULL token. Those rows are the only ones still
 * reachable without a token (legacy grace), and the doc/abandon gates rely on
 * tokens existing for NEW rows. Fill the gap lazily (first DB use in any
 * process) so every legacy row also gets a token and the NULL-legacy path
 * disappears over time. gen_random_uuid() is built into PostgreSQL 13+, which
 * Neon runs, so no extension is needed. Idempotent — safe to re-run.
 */
const gBackfill = globalThis as unknown as { __RK_TOKEN_BACKFILL__?: boolean }
function runLegacyBackfill(client: PrismaClient): void {
  if (gBackfill.__RK_TOKEN_BACKFILL__) return
  gBackfill.__RK_TOKEN_BACKFILL__ = true
  client
    .$executeRawUnsafe(
      `UPDATE "Booking" SET "downloadToken" = gen_random_uuid()::text WHERE "downloadToken" IS NULL`
    )
    .then((n) => {
      if (n > 0) console.log(`[db] backfilled downloadToken on ${n} legacy booking(s)`)
    })
    .catch((e) => {
      console.error("[db] downloadToken backfill failed (non-fatal):", e)
    })
}

/**
 * Compatibility default export — every existing `db.` call site keeps working
 * unchanged, but each access resolves against the CURRENT burst's client, so
 * a request landing on a suspended-and-resumed isolate can never touch a dead
 * socket pool.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getDb()
    const value = Reflect.get(client as unknown as object, prop, client)
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(client) : value
  },
})
