/**
 * seo.ts — shared helpers for page metadata.
 *
 * RULES enforced here:
 *   - <title> must stay under 60 characters.
 *   - meta description must stay under 155 characters.
 *   - canonicals are always built from SITE_URL (never hardcoded domains).
 */
import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "./site.config";

/** Hard limits from the SEO spec. */
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;

/**
 * Development-only guardrail: warns in the server console when a title or
 * description exceeds the SEO limits. In production this is a no-op.
 */
function warnIfOver(kind: "title" | "description", value: string, max: number) {
  if (process.env.NODE_ENV !== "development") return;
  if (value.length > max) {
    console.warn(
      `[seo] WARNING: ${kind} is ${value.length} chars (limit ${max}): "${value}"`
    );
  }
}

/**
 * Build a page <title> from a page-specific title and append the brand
 * suffix when there is room, guaranteeing the result stays under 60 chars.
 */
export function seoTitle(pageTitle: string, brand: string = SITE_NAME): string {
  const clean = pageTitle.trim().replace(/\s+/g, " ");
  if (clean.length <= TITLE_MAX) {
    warnIfOver("title", clean, TITLE_MAX);
    return clean;
  }
  const withBrand = `${clean} — ${brand}`;
  if (withBrand.length <= TITLE_MAX) {
    warnIfOver("title", withBrand, TITLE_MAX);
    return withBrand;
  }
  const truncated = clean.slice(0, TITLE_MAX - 1).trimEnd() + "…";
  warnIfOver("title", truncated, TITLE_MAX);
  return truncated;
}

/**
 * Build a page <title> of the form "Page — Brand", total under 60 chars.
 */
export function titledPageTitle(pageTitle: string, brand: string = SITE_NAME): string {
  const clean = pageTitle.trim().replace(/\s+/g, " ");
  const withBrand = `${clean} — ${brand}`;
  if (withBrand.length <= TITLE_MAX) {
    warnIfOver("title", withBrand, TITLE_MAX);
    return withBrand;
  }
  return seoTitle(clean, brand);
}

/**
 * Trim a meta description to 155 characters without cutting mid-word.
 */
export function seoDescription(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= DESCRIPTION_MAX) {
    warnIfOver("description", clean, DESCRIPTION_MAX);
    return clean;
  }
  const cut = clean.slice(0, DESCRIPTION_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const truncated = (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
  warnIfOver("description", truncated, DESCRIPTION_MAX);
  return truncated;
}

/**
 * Absolute canonical URL for a path, e.g. absUrl("/rooms/xyz").
 * The path must start with "/". Query strings are ignored by design —
 * canonicals must point at the clean, indexable URL.
 */
export function absUrl(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/* ── WhatsApp-safe OG cover images ──────────────────────────────────────
 * WhatsApp, iMessage and most chat apps do NOT render WebP link-preview
 * thumbnails — the og:image must point at a plain JPEG, ideally 1200x630
 * (1.905:1) and under ~300KB. The curated covers live in public/og/ and are
 * built from the site's real photography. resolveOgImage() maps every page's
 * image candidate (legacy .webp paths, DB uploads, odd-sized photos) onto
 * these covers, so no page can ever ship a WebP og:image again.
 */
export const OG_IMAGE_DEFAULT = "/og/og-home.jpg";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/** Curated section covers (all JPEG 1200x630 under public/og/). */
export const OG_SECTION_IMAGE = {
  rooms: "/og/og-rooms.jpg",
  dining: "/og/og-dining.jpg",
  experiences: "/og/og-experiences.jpg",
  festivals: "/og/og-festivals.jpg",
  blog: "/og/og-festivals.jpg",
} as const;

/** Legacy /images/<photo>.(webp|jpg) basename → its curated JPEG cover. */
const OG_COVER_BY_PHOTO: Record<string, string> = {
  "hero-vrindavan": OG_IMAGE_DEFAULT,
  "heritage-room": OG_SECTION_IMAGE.rooms,
  "satvik-dining": OG_SECTION_IMAGE.dining,
  "yamuna-aarti": OG_SECTION_IMAGE.experiences,
  "marigold-garland": OG_SECTION_IMAGE.festivals,
};

/**
 * Resolve any incoming og:image candidate to a WhatsApp-safe JPEG cover:
 *   1. already a curated /og/*.jpg       → keep as-is
 *   2. a known /images/<photo> file      → its curated JPEG cover
 *   3. unknown / undefined (DB uploads,  → the path's section cover when one
 *      external URLs, portrait photos)      exists, else the brand hero
 */
export function resolveOgImage(image?: string | null, path?: string): string {
  const clean = (image ?? "").split("?")[0].toLowerCase();
  if (clean.startsWith("/og/") && /\.(jpe?g|png)$/.test(clean)) {
    return (image as string).split("?")[0];
  }
  const base = clean.replace(/^.*\//, "").replace(/\.(webp|jpe?g|png|avif|gif)$/, "");
  if (OG_COVER_BY_PHOTO[base]) return OG_COVER_BY_PHOTO[base];
  const seg = path?.split("/").filter(Boolean)[0];
  const sectionCover = seg
    ? OG_SECTION_IMAGE[seg as keyof typeof OG_SECTION_IMAGE]
    : undefined;
  return sectionCover ?? OG_IMAGE_DEFAULT;
}

/**
 * Open Graph metadata for a page. og:url always equals the page canonical;
 * title/description are the page's own; the image is always resolved to a
 * WhatsApp-safe JPEG cover (see resolveOgImage) — chat-app previews break on
 * WebP or oddly-sized photos. Relative paths resolve against metadataBase
 * (set in the root layout from SITE_URL).
 */
export function pageOpenGraph(opts: {
  path: string;
  title: string;
  description: string;
  image?: string;
  type?: "website" | "article";
}): Metadata["openGraph"] {
  return {
    title: opts.title,
    description: opts.description,
    url: absUrl(opts.path),
    siteName: SITE_NAME,
    locale: "en_IN",
    type: opts.type ?? "website",
    images: [
      {
        url: resolveOgImage(opts.image, opts.path),
        width: OG_IMAGE_WIDTH,
        height: OG_IMAGE_HEIGHT,
        alt: opts.title,
      },
    ],
  };
}

/** Twitter card metadata matching the page's OG tags (same JPEG cover). */
export function pageTwitter(opts: {
  title: string;
  description: string;
  image?: string;
  path?: string;
}): Metadata["twitter"] {
  return {
    card: "summary_large_image",
    title: opts.title,
    description: opts.description,
    images: [resolveOgImage(opts.image, opts.path)],
  };
}
