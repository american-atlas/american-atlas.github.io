/* American History Atlas service worker.
 *
 * - Pages: network first, falling back to the cached copy, then to /offline/.
 * - The full-text search index (~240 KB compressed) is not precached; it is cached the first
 *   time the reader opens Search.
 * - Build assets, images, fonts, map: cache first (they are content-addressed or rarely change).
 * - Saved entries: when a reader taps Save, the page sends {type:"save-entry", id}; the entry page
 *   and its images go into a separate cache that is never trimmed.
 */
const VERSION = "3139670e38"; // replaced at build time by scripts/stamp-sw.ts
const SHELL = `atlas-shell-${VERSION}`;
const PAGES = `atlas-pages-${VERSION}`;
const ASSETS = `atlas-assets-${VERSION}`;
const SAVED = "atlas-saved"; // kept across versions on purpose
const PAGE_LIMIT = 150;
const ASSET_LIMIT = 400;

const SHELL_URLS = [
  "/",
  "/offline/",
  "/saved/",
  "/learn/",
  "/learn/review/",
  "/learn/quiz/",
  "/learn/cards/",
  "/learn.json",
  "/search/",
  "/timeline/",
  "/explore/",
  "/map/",
  "/cards.json",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/map/us-land.svg",
  "/map/us-borders.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => Promise.all(SHELL_URLS.map((u) => c.add(u).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SAVED && !k.endsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function fromAnyCache(request, opts) {
  return (
    (await caches.match(request, opts)) ||
    (await caches.match(request, { ...opts, ignoreSearch: true }))
  );
}

async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (res.ok && res.type === "basic") {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(request, copy).then(() => trim(cacheName, PAGE_LIMIT)));
    }
    return res;
  } catch {
    const cached = await fromAnyCache(request);
    if (cached) return cached;
    if (request.mode === "navigate") return (await caches.match("/offline/")) || Response.error();
    return Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) {
    const copy = res.clone();
    caches.open(ASSETS).then((c) => c.put(request, copy).then(() => trim(ASSETS, ASSET_LIMIT)));
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // external sources and links: always live

  const p = url.pathname;
  if (p.startsWith("/_next/static/") || p.startsWith("/images/") || p.startsWith("/icons/") || p.startsWith("/map/") || /\.(woff2?|png|jpe?g|webp|svg)$/.test(p)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // HTML navigations, RSC payloads for client-side navigation, and JSON indexes.
  event.respondWith(networkFirst(request, PAGES));
});

async function saveEntry(id) {
  const cache = await caches.open(SAVED);
  const pageUrl = `/entry/${id}/`;
  try {
    const res = await fetch(pageUrl);
    if (!res.ok) return;
    const html = await res.clone().text();
    await cache.put(pageUrl, res);
    // Also keep the entry's images and the static chunks the page needs.
    const assets = new Set();
    for (const m of html.matchAll(/(?:src|href)="(\/(?:images|_next\/static)\/[^"]+)"/g)) assets.add(m[1]);
    await Promise.all(
      [...assets].map((u) =>
        fetch(u)
          .then((r) => (r.ok ? cache.put(u, r) : undefined))
          .catch(() => undefined),
      ),
    );
  } catch {
    /* offline right now — the page will be cached on the next visit */
  }
}

async function unsaveEntry(id) {
  const cache = await caches.open(SAVED);
  await cache.delete(`/entry/${id}/`);
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "save-entry" && typeof data.id === "string") event.waitUntil(saveEntry(data.id));
  if (data.type === "unsave-entry" && typeof data.id === "string") event.waitUntil(unsaveEntry(data.id));
});
