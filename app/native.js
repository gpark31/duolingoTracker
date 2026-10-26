/* Android glue (Capacitor). Loaded on the web too, where Native.isNative is false and nothing here runs.
   - Reminders: scheduled by Android itself with the local-notifications plugin, three weeks ahead, rebuilt on every save.
   - Widget: the app writes a summary to Preferences (SharedPreferences "CapacitorStorage"), which the Java
     widget reads; the widget's "+1" taps are queued under "widgetAdds" for the app to merge.
   - Sync: CapacitorHttp sends fetch() natively, so Duolingo is called directly with no relay. */
(function (root) {
  "use strict";
  // vendor/capacitor.js (copied from @capacitor/core by `npm run sync`) defines capacitorExports.
  const core = root.capacitorExports;
  const Cap = core ? core.Capacitor : root.Capacitor;
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const C = root.DuoCore;
  const P = {};
  if (isNative) {
    ["Preferences", "LocalNotifications", "App", "LessonWidget"].forEach(function (name) { P[name] = core.registerPlugin(name); });
  }
  const DUO_API = "https://www.duolingo.com/2017-06-30/users";
  // Three weeks of reminders, so they keep coming even if the app isn't opened for a while.
  const REMINDER_IDS = Array.from({ length: 21 }, function (_, i) { return 101 + i; });
  const TEST_ID = 199;

  /* ---------- Duolingo, direct (mirrors server.py) ---------- */
  async function getJson(url, token) {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    let res;
    try { res = await fetch(url, { headers: headers }); } catch (e) { throw new Error("Couldn't reach Duolingo. Check your connection."); }
    if (!res.ok) { const err = new Error("Duolingo answered with an error (" + res.status + ")."); err.status = res.status; throw err; }
    return res.json();
  }
  async function lookup(username, token) {
    if (!/^[A-Za-z0-9_.\-]{1,40}$/.test(username)) throw new Error("That doesn't look like a Duolingo username.");
    const fields = "users{id,username,streak,totalXp,currentCourseId,courses}";
    const data = await getJson(DUO_API + "?username=" + encodeURIComponent(username) + "&fields=" + encodeURIComponent(fields));
    const user = (data.users || [])[0];
    if (!user) throw new Error("No Duolingo user named “" + username + "”.");
    const courses = user.courses || [];
    let cur = courses.find(function (c) { return c.id === user.currentCourseId; });
    if (!cur && courses.length) cur = courses.reduce(function (a, c) { return (c.xp || 0) > (a.xp || 0) ? c : a; });
    const out = {
      username: user.username, streak: user.streak, totalXp: user.totalXp,
      courseTitle: cur ? cur.title : null, courseXp: cur ? cur.xp : null, gains: null
    };
    if (token && user.id != null) {
      try {
        const raw = await getJson(DUO_API + "/" + Number(user.id) + "?fields=xpGains", token);
        out.gains = (raw.xpGains || []).filter(function (g) { return Number.isFinite(Number(g.time)); })
          .map(function (g) { return { t: Math.trunc(Number(g.time)), xp: Math.trunc(Number(g.xp) || 0) }; });
      } catch (e) {
        out.gainsError = e.status === 401 || e.status === 403
          ? "Your login token was rejected, so lessons were estimated from XP."
          : "Lesson history unavailable right now, so lessons were estimated from XP.";
      }
    }
    return out;
  }

  /* ---------- widget ---------- */
  async function saveWidget(st) {
    const now = new Date();
    const s = C.summary(st, now);
    const w = Object.assign(C.widgetData(st, now), { date: s.today, doneN: s.done, goalN: s.goal });
    await P.Preferences.set({ key: "widget", value: JSON.stringify(w) });
    if (P.LessonWidget) await P.LessonWidget.refresh();
  }
  /* Returns {date: count} of "+1" taps made on the widget since the last call, and clears them. */
  async function takeWidgetAdds() {
    const r = await P.Preferences.get({ key: "widgetAdds" });
    if (!r || !r.value) return {};
    await P.Preferences.remove({ key: "widgetAdds" });
    try { return JSON.parse(r.value) || {}; } catch (e) { return {}; }
  }

  /* ---------- reminders ---------- */
  async function canExact() {
    try { return (await P.LocalNotifications.checkExactNotificationSetting()).exact_alarm === "granted"; } catch (e) { return false; }
  }
  async function permission() {
    try { return (await P.LocalNotifications.checkPermissions()).display; } catch (e) { return "denied"; }
  }
  async function requestPermission() {
    try { return (await P.LocalNotifications.requestPermissions()).display === "granted"; } catch (e) { return false; }
  }
  async function scheduleReminders(st) {
    await P.LocalNotifications.cancel({ notifications: REMINDER_IDS.map(function (id) { return { id: id }; }) });
    if (!st.notify.on || (await permission()) !== "granted") return 0;
    const exact = await canExact();
    const hm = st.notify.time.split(":").map(Number);
    const now = new Date();
    const list = [];
    REMINDER_IDS.forEach(function (id, i) {
      const day = C.addDays(now, i);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hm[0], hm[1]);
      if (at <= now) return;
      // Today's note reflects what's logged so far; later days start from zero lessons.
      const n = C.reminderNote(C.summary(st, at));
      list.push({
        id: id, title: n.title, body: n.body, largeBody: n.body,
        schedule: { at: at, allowWhileIdle: true }, isExactNotification: exact
      });
    });
    if (list.length) await P.LocalNotifications.schedule({ notifications: list });
    return list.length;
  }
  async function testNotification(st) {
    const n = C.reminderNote(C.summary(st, new Date()));
    await P.LocalNotifications.schedule({ notifications: [{
      id: TEST_ID, title: n.title, body: n.body, largeBody: n.body,
      schedule: { at: new Date(Date.now() + 1500), allowWhileIdle: true }, isExactNotification: false
    }] });
  }
  async function openExactSetting() {
    try { return (await P.LocalNotifications.changeExactNotificationSetting()).exact_alarm === "granted"; } catch (e) { return false; }
  }

  /* Debounced: every save refreshes the widget and the week of scheduled reminders. */
  let timer = 0, latest = null;
  function onSave(st) {
    latest = st;
    clearTimeout(timer);
    timer = setTimeout(function () {
      const s = latest;
      saveWidget(s).catch(function () {});
      scheduleReminders(s).catch(function () {});
    }, 600);
  }

  /* Asks the launcher to place the widget (Android 8+ with a supporting launcher). Resolves false if it can't. */
  async function pinWidget() {
    try { return (await P.LessonWidget.pin()).requested === true; } catch (e) { return false; }
  }

  function onResume(cb) {
    if (P.App) P.App.addListener("resume", cb);
  }

  root.Native = {
    isNative: isNative, lookup: lookup, onSave: onSave, onResume: onResume, takeWidgetAdds: takeWidgetAdds,
    scheduleReminders: scheduleReminders, testNotification: testNotification, pinWidget: pinWidget,
    permission: permission, requestPermission: requestPermission, canExact: canExact, openExactSetting: openExactSetting
  };
})(window);
