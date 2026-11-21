// The phone page's push service worker (nightshift item 739), served at
// /push-sw.js so its scope is the whole page.
//
// It does two things and nothing else: show the notification a push
// carries, and open the chat a tapped notification names. No fetch
// handler, no cache — the page loads exactly as it did without it. It
// holds no token and calls no host: what it shows is what the push said
// (the chat's name and its state; blocker 2011).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    // A push that does not read is still shown: iOS withdraws the
    // permission of a page whose pushes show nothing.
  }
  const title = typeof d.title === "string" && d.title ? d.title : "Nightloom";
  const work = [
    self.registration.showNotification(title, {
      body: typeof d.body === "string" ? d.body : "",
      // One notification per chat: a newer one replaces the older.
      tag: typeof d.tag === "string" && d.tag ? d.tag : "nightloom",
      icon: "/remote/icon-256.png",
      data: { chat: d.chat ?? null, project: d.project ?? null, host: d.host ?? null },
    }),
  ];
  if (typeof d.badge === "number" && "setAppBadge" in self.navigator) {
    work.push((d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  event.waitUntil(Promise.all(work));
});

/** `#chat=<id>&project=<pid>&host=<role>` — the page's own place (place.ts). */
function placeHash(d) {
  if (!d || typeof d.chat !== "string" || !d.chat) return "";
  const parts = ["chat=" + encodeURIComponent(d.chat)];
  if (typeof d.project === "string" && d.project) parts.push("project=" + encodeURIComponent(d.project));
  if (d.host === "mac" || d.host === "away") parts.push("host=" + d.host);
  return "#" + parts.join("&");
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of open) {
        // The page is alive: it opens the chat itself, keeping its state.
        c.postMessage({ type: "nightloom-open", chat: d.chat ?? null, project: d.project ?? null, host: d.host ?? null });
        try {
          await c.focus();
        } catch {
          // Not focusable from here; the message still landed.
        }
        return;
      }
      await self.clients.openWindow("/" + placeHash(d));
    })(),
  );
});
