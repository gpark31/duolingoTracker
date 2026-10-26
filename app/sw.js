/* Service worker: offline shell, background reminder checks, and the Windows 11 widget. */
importScripts("core.js");
const C = self.DuoCore;

const SHELL_CACHE = "duo-shell-v2";
const DATA_CACHE = "duo-data";
const STATE_URL = new URL("__state.json", self.registration.scope).href;
const WIDGET_TAG = "today";
const SHELL = ["./", "index.html", "styles.css", "core.js", "app.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "widgets/today.template.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL_CACHE && k !== DATA_CACHE) await caches.delete(k);
    await self.clients.claim();
    await updateWidget();
  })());
});

/* ---------- state shared with the page through the Cache API ---------- */
async function loadState() {
  try {
    const r = await (await caches.open(DATA_CACHE)).match(STATE_URL);
    return C.normalize(r ? await r.json() : null);
  } catch (e) { return C.normalize(null); }
}
async function saveState(st) {
  st.updatedAt = Date.now();
  const c = await caches.open(DATA_CACHE);
  await c.put(STATE_URL, new Response(JSON.stringify(st), { headers: { "content-type": "application/json" } }));
  for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "state-changed" });
}

/* ---------- fetch: network first for the app shell so updates land, cache when offline ---------- */
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.endsWith("/widgets/today.data.json")) {
    e.respondWith(loadState().then((st) => new Response(JSON.stringify(C.widgetData(st)), { headers: { "content-type": "application/json" } })));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(SHELL_CACHE)).put(e.request, res.clone());
      return res;
    } catch (err) {
      return (await caches.match(e.request, { ignoreSearch: true })) || (await caches.match("index.html")) || Response.error();
    }
  })());
});

/* ---------- daily reminder (periodic background sync, installed Chrome/Edge) ---------- */
async function dailyCheck() {
  let st = await loadState();
  const now = new Date();
  if (st.duo.username && Date.now() - st.duo.lastSync > 60 * 60 * 1000) {
    try { st = await C.syncDuolingo(st, self.location.origin, now); await saveState(st); } catch (e) { /* offline or relay down */ }
  }
  if (C.shouldRemind(st, now) && self.Notification && Notification.permission === "granted") {
    const n = C.reminderNote(C.summary(st, now));
    st.notify.lastSent = C.ymd(now);
    await saveState(st);
    await self.registration.showNotification(n.title, {
      body: n.body, icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: "daily", data: { url: "./" }
    });
  }
  await updateWidget();
}
self.addEventListener("periodicsync", (e) => {
  if (e.tag === "daily-check") e.waitUntil(dailyCheck());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.length) return wins[0].focus();
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || "./");
  })());
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "state-updated") e.waitUntil(updateWidget());
});

/* ---------- Windows 11 widget (Edge on Windows 11; ignored elsewhere) ---------- */
async function renderWidget(widget) {
  const tpl = await (await fetch(widget.definition.msAcTemplate)).text();
  const data = JSON.stringify(C.widgetData(await loadState()));
  await self.widgets.updateByTag(widget.definition.tag, { template: tpl, data: data });
}
async function updateWidget() {
  if (!self.widgets) return;
  try {
    const w = await self.widgets.getByTag(WIDGET_TAG);
    if (w) await renderWidget(w);
  } catch (e) { /* widget host not ready */ }
}
self.addEventListener("widgetinstall", (e) => e.waitUntil(renderWidget(e.widget)));
self.addEventListener("widgetresume", (e) => e.waitUntil(renderWidget(e.widget)));
self.addEventListener("widgetclick", (e) => {
  e.waitUntil((async () => {
    if (e.action === "addLesson") {
      const st = await loadState();
      const k = C.ymd(new Date());
      st.log[k] = (st.log[k] || 0) + 1;
      st.src[k] = "manual";
      await saveState(st);
      await updateWidget();
    } else if (e.action === "open") {
      await self.clients.openWindow("./");
    }
  })());
});
