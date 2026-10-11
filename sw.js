const SHARE_CACHE = "kobo-drop-share";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== new URL("share", self.registration.scope).pathname) return;
  event.respondWith(
    (async () => {
      const form = await event.request.formData();
      const cache = await caches.open(SHARE_CACHE);
      const files = form.getAll("books").filter((f) => f instanceof File);
      await Promise.all(
        files.map((file, n) =>
          cache.put(`shared/${Date.now()}-${n}`, new Response(file, { headers: { "x-name": encodeURIComponent(file.name) } }))
        )
      );
      return Response.redirect(new URL("./?shared=1", self.registration.scope).href, 303);
    })()
  );
});
