const CACHE = "myitem-v3";
const PRECACHE = ["/", "/manage.html", "/manifest.webmanifest", "/logo-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function isNavigation(req) {
  return req.mode === "navigate" || req.destination === "document";
}

function canCache(res) {
  // Never cache redirects — Safari rejects navigations served as SW redirects
  return (
    res &&
    res.ok &&
    res.status === 200 &&
    res.type === "basic" &&
    !res.redirected
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req));
    return;
  }

  if (isNavigation(req)) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (canCache(res)) {
            const cache = await caches.open(CACHE);
            await cache.put(req, res.clone());
            if (url.pathname === "/manage" || url.pathname === "/manage/") {
              await cache.put("/manage.html", res.clone());
            }
          }
          return res;
        } catch (err) {
          const cached =
            (await caches.match(req)) ||
            (await caches.match(url.pathname)) ||
            (url.pathname.startsWith("/manage")
              ? await caches.match("/manage.html")
              : null) ||
            (await caches.match("/"));
          if (cached) return cached;
          return new Response("Offline", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          });
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (canCache(res)) {
          const cache = await caches.open(CACHE);
          await cache.put(req, res.clone());
        }
        return res;
      } catch (err) {
        return new Response("", { status: 504 });
      }
    })()
  );
});
