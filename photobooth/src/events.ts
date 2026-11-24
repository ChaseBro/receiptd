// Events (parties / albums): pure helpers, no Worker APIs, so they run under
// `node --test` too. Everything lives in the private PHOTOS bucket next to the
// day folders (which only ever match YYYY-MM-DD, so these never collide):
//
//   ${prefix}events/<slug>/event.json        the event (name, date, themes, share token…)
//   ${prefix}events/<slug>/s/<day>/<id>      album index: one empty object per session
//   ${prefix}share/<token>                   share token → slug (public album lookup)
//   ${prefix}active-event                    slug the booths are shooting for right now
//
// A session joins an event's album when its archive upload carries
// `meta.event` (the booth sets it from the active event), or when an adult
// attaches a whole day from the party page.

import { DAY_RE, ID_RE, isDay } from "./archive.ts";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** 12 chars of [a-z2-9] ≈ 60 bits: unguessable, short enough for a small QR. */
export const TOKEN_RE = /^[a-hjkmnp-z2-9]{12}$/;
const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";   // no i/l/o/0/1

export const MAX_EVENT_THEMES = 12;
export const THEME_RE = /^[a-z0-9-]{1,20}$/;

export interface BoothEvent {
  slug: string;
  name: string;
  /** YYYY-MM-DD (the party day; informational). */
  date?: string;
  /** Themes offered on the booth while this event is active (empty = all). */
  themes: string[];
  /** Theme the booth switches to when the event becomes active. */
  theme?: string;
  /** Printed under the ticket stub (replaces the per-device footer). */
  footer?: string;
  /** Print a QR code linking to the guest's photos on every strip. */
  qr: boolean;
  /** Public album token (/a/<share>). Rotating it kills old links. */
  share: string;
  createdAt: string;
  updatedAt: string;
}

export const eventKey = (prefix: string, slug: string) => `${prefix}events/${slug}/event.json`;
export const indexPrefix = (prefix: string, slug: string) => `${prefix}events/${slug}/s/`;
export const indexKey = (prefix: string, slug: string, day: string, id: string) => {
  if (!SLUG_RE.test(slug) || !isDay(day) || !ID_RE.test(id)) throw new Error("bad_key");
  return `${indexPrefix(prefix, slug)}${day}/${id}`;
};
export const shareKey = (prefix: string, token: string) => `${prefix}share/${token}`;
export const activeKey = (prefix: string) => `${prefix}active-event`;

/** Index object key → { day, id } (or null). */
export function parseIndexKey(prefix: string, slug: string, key: string): { day: string; id: string } | null {
  const base = indexPrefix(prefix, slug);
  if (!key.startsWith(base)) return null;
  const [day, id, ...rest] = key.slice(base.length).split("/");
  if (rest.length || !day || !id || !DAY_RE.test(day) || !isDay(day) || !ID_RE.test(id)) return null;
  return { day, id };
}

export function newToken(rand: Uint8Array = crypto.getRandomValues(new Uint8Array(12))): string {
  return Array.from(rand.slice(0, 12), (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]).join("");
}

/** "Thanksgiving 2026!" → "thanksgiving-2026". */
export function slugify(name: string): string {
  const s = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return SLUG_RE.test(s) ? s : "party";
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : undefined);

/**
 * Validate + bound an event create/update body. Returns the cleaned fields or
 * an error code. `partial` (update) lets fields be omitted.
 */
export function cleanEventInput(raw: unknown, partial = false):
  { ok: true; value: Partial<Pick<BoothEvent, "name" | "date" | "themes" | "theme" | "footer" | "qr">> } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Partial<BoothEvent> = {};
  if (r.name !== undefined || !partial) {
    const name = str(r.name, 60);
    if (!name) return { ok: false, error: "invalid_name" };
    out.name = name;
  }
  if (r.date !== undefined && r.date !== null && r.date !== "") {
    if (!isDay(r.date)) return { ok: false, error: "invalid_date" };
    out.date = r.date;
  } else if (r.date === "" || r.date === null) out.date = undefined;
  if (r.themes !== undefined) {
    if (!Array.isArray(r.themes) || r.themes.length > MAX_EVENT_THEMES || !r.themes.every((t) => typeof t === "string" && THEME_RE.test(t))) {
      return { ok: false, error: "invalid_themes" };
    }
    out.themes = [...new Set(r.themes as string[])];
  } else if (!partial) out.themes = [];
  if (r.theme !== undefined && r.theme !== null && r.theme !== "") {
    if (typeof r.theme !== "string" || !THEME_RE.test(r.theme)) return { ok: false, error: "invalid_theme" };
    out.theme = r.theme;
  } else if (r.theme === null || r.theme === "") out.theme = undefined;   // explicit clear
  if (r.footer !== undefined) out.footer = str(r.footer, 40) ?? "";
  if (r.qr !== undefined) {
    if (typeof r.qr !== "boolean") return { ok: false, error: "invalid_qr" };
    out.qr = r.qr;
  } else if (!partial) out.qr = true;
  // The default theme must be one the event offers.
  const themes = out.themes;
  if (out.theme && themes?.length && !themes.includes(out.theme)) return { ok: false, error: "theme_not_offered" };
  return { ok: true, value: out };
}

/** What the public album shows about an event (no share token, no booth config). */
export function publicEvent(e: BoothEvent) {
  return { slug: e.slug, name: e.name, date: e.date ?? null, theme: e.theme ?? e.themes[0] ?? null };
}
