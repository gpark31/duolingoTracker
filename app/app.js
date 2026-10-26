/* Page UI. All numbers come from core.js; this file renders them, handles input, saving, sync and reminders. */
(function () {
  "use strict";
  const C = window.DuoCore;
  const N = window.Native; // Android glue; N.isNative is false on the web
  const LS_KEY = "duo-tracker-v1";
  const DATA_CACHE = "duo-data";
  const STATE_URL = "__state.json"; // shared with sw.js so the widget and background checks see the same data
  const AUTO_SYNC_MS = 30 * 60 * 1000;

  const $ = function (id) { return document.getElementById(id); };
  const esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  /* ---------- state and saving ---------- */
  function loadLocal() { try { return JSON.parse(lsGet(LS_KEY) || "null"); } catch (e) { return null; } }
  let st = C.normalize(loadLocal());
  const PAGES = ["today", "progress", "summary", "settings"];
  const ui = {
    page: PAGES.indexOf(lsGet("duo-page")) >= 0 ? lsGet("duo-page") : "today",
    tab: ["week", "cal", "graph"].indexOf(lsGet("duo-tab")) >= 0 ? lsGet("duo-tab") : "week",
    weekOffset: 0, calMonth: null, graphDays: Number(lsGet("duo-graph")) || 14, editing: null, syncing: false
  };

  async function mirror() {
    try {
      const c = await caches.open(DATA_CACHE);
      await c.put(STATE_URL, new Response(JSON.stringify(st), { headers: { "content-type": "application/json" } }));
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (sw) sw.postMessage({ type: "state-updated" });
    } catch (e) { /* no Cache API (file://) */ }
  }
  function commit() {
    const now = new Date();
    const s = C.summary(st, now);
    let cheer = null;
    if (s.met && st.notify.cheered !== s.today) {
      st.notify.cheered = s.today;
      cheer = C.encourage(s, "cheer");
    }
    st.updatedAt = Date.now();
    lsSet(LS_KEY, JSON.stringify(st));
    mirror();
    if (N.isNative) N.onSave(st);
    render();
    if (cheer) {
      toast("🎉 " + cheer);
      if (document.hidden && !N.isNative) showNote("Goal done for today", cheer, "cheer");
    }
  }
  /* Android: fold in "+1 lesson" taps made on the home-screen widget. */
  async function mergeWidgetAdds() {
    let any = false;
    try {
      const adds = await N.takeWidgetAdds();
      Object.keys(adds).forEach(function (k) {
        const n = Math.round(Number(adds[k]));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !(n > 0)) return;
        st.log[k] = Math.min(500, (st.log[k] || 0) + n);
        st.src[k] = "manual";
        any = true;
      });
    } catch (e) { /* plugin unavailable */ }
    if (any) commit(); else N.onSave(st);
  }
  /* The widget's "+1 lesson" and background syncs write to the cache copy; adopt it when it is newer. */
  async function adoptNewer() {
    try {
      const c = await caches.open(DATA_CACHE);
      const r = await c.match(STATE_URL);
      if (!r) { mirror(); return; }
      const remote = C.normalize(await r.json());
      if (remote.updatedAt > st.updatedAt) {
        st = remote;
        lsSet(LS_KEY, JSON.stringify(st));
        render();
      }
    } catch (e) { /* ignore */ }
  }
  function setDay(k, lessons, mins) {
    if (lessons == null || lessons === "" || !(Number(lessons) >= 0)) { delete st.log[k]; delete st.src[k]; }
    else { st.log[k] = Math.min(500, Math.round(Number(lessons))); st.src[k] = "manual"; }
    if (mins !== undefined) setMins(k, mins);
  }
  function setMins(k, mins) {
    if (mins === "" || !(Number(mins) > 0)) delete st.mins[k];
    else st.mins[k] = Math.min(1440, Math.round(Number(mins) * 60) / 60);
  }
  /* Minutes and seconds boxes -> minutes; both blank clears the day. */
  function readTime(minEl, secEl) {
    if (minEl.value === "" && secEl.value === "") return "";
    return (Number(minEl.value) || 0) + (Number(secEl.value) || 0) / 60;
  }
  function splitTime(min) {
    const s = Math.round((min || 0) * 60);
    return { m: Math.floor(s / 60), s: s % 60 };
  }

  /* ---------- formatting ---------- */
  function fmtDate(k, opts) { return C.pd(k).toLocaleDateString(undefined, opts || { weekday: "short", month: "short", day: "numeric" }); }
  function fmtDur(min) {
    min = Math.round(min);
    const h = Math.floor(min / 60), m = min % 60;
    return h ? h + " h " + m + " m" : m + " min";
  }
  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
  }
  /* Exact logged time, e.g. "12 min 30 s". */
  function fmtMS(min) {
    const p = splitTime(min);
    if (p.m >= 60) return fmtDur(min);
    return p.s ? (p.m ? p.m + " min " : "") + p.s + " s" : p.m + " min";
  }
  const word = C.lessonWord;

  /* ---------- render ---------- */
  function render() {
    const now = new Date();
    const s = C.summary(st, now);
    renderPages();
    renderHeader(s);
    renderToday(s, now);
    renderWeekTime(now);
    renderPlan(s);
    renderView(s, now);
    renderTime(s);
    renderDuo();
    renderSync();
  }

  /* Show the page picked in the bottom navigation bar. */
  function renderPages() {
    PAGES.forEach(function (p) {
      const on = p === ui.page;
      $("page-" + p).hidden = !on;
      const b = $("nav-" + p);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
  }
  function goPage(p) {
    if (PAGES.indexOf(p) < 0) return;
    const changed = p !== ui.page;
    ui.page = p; lsSet("duo-page", p);
    render();
    if (changed) window.scrollTo(0, 0);
  }

  function renderHeader(s) {
    $("course").textContent = st.duo.courseTitle ? st.duo.courseTitle + " · Duolingo" : "Duolingo progress";
    let h = "";
    if (s.duoStreak) h += '<span class="chip hot" title="Your Duolingo streak">🔥 <span class="num">' + s.duoStreak + "</span> day streak</span>";
    h += '<span class="chip" title="Days in a row you hit your daily goal">🎯 <span class="num">' + s.goalStreak + "</span> " + (s.goalStreak === 1 ? "day" : "days") + " on goal</span>";
    $("chips").innerHTML = h;
  }

  function renderToday(s, now) {
    const scale = Math.max(s.done, s.goal);
    const goalW = (Math.min(s.done, s.goal) / scale) * 100;
    const bonusW = (s.extra / scale) * 100;
    const src = st.src[s.today] === "sync" ? '<span class="pill">synced</span>' : "";
    const pill = s.extra > 0 ? '<span class="pill gold">+' + s.extra + " extra</span>" : s.met ? '<span class="pill">goal met</span>' : "";
    const t = s.time;
    const tm = st.mins[s.today] ? splitTime(st.mins[s.today]) : null;
    const ta = splitTime(t.todayMin); // average-based time when none is entered
    const focusId = document.activeElement && $("todaycard").contains(document.activeElement) ? document.activeElement.id : null;
    $("todaycard").className = "card hero" + (s.met ? " ok" : "");
    $("todaycard").innerHTML =
      "<h2>Today · " + esc(fmtDate(s.today)) + "</h2>" +
      '<div class="today-row">' +
        '<div class="big num">' + s.done + "<small> / " + s.goal + " " + word(s.goal) + "</small>" + pill + src + "</div>" +
        '<div class="stepper">' +
          '<button class="step" type="button" data-act="minus" aria-label="Remove a lesson"' + (s.done ? "" : " disabled") + ">−</button>" +
          '<button class="step plus" type="button" data-act="plus" aria-label="Add a lesson">+</button>' +
        "</div>" +
      "</div>" +
      '<div class="bar" role="progressbar" aria-label="Today\'s goal" aria-valuemin="0" aria-valuemax="' + s.goal + '" aria-valuenow="' + s.done + '">' +
        '<i style="width:' + goalW + '%"></i><i class="bonus" style="width:' + bonusW + '%"></i></div>' +
      '<p class="cheer">' + esc(C.encourage(s, "today")) + "</p>" +
      '<div class="mins-row">' +
        '<div class="field"><label for="todayMins">Minutes today</label><input id="todayMins" type="number" min="0" max="1440" inputmode="numeric" value="' + (tm ? tm.m : "") + '" placeholder="' + ta.m + '"></div>' +
        '<span class="sep" aria-hidden="true">:</span>' +
        '<div class="field"><label for="todaySecs">Seconds</label><input id="todaySecs" type="number" min="0" max="59" inputmode="numeric" value="' + (tm ? tm.s : "") + '" placeholder="' + ta.s + '"></div>' +
        (t.todayEstimated ? '<p class="fine" style="flex-basis:100%;margin:0">No time entered, so ' + fmtMS(t.todayMin) + " is counted from your average (" + fmtMS(t.avg) + " per lesson).</p>" : "") +
        '<div class="field date"><label for="otherDay">Edit another day</label><input id="otherDay" type="date" max="' + s.today + '"></div>' +
      "</div>";
    if (focusId && $(focusId)) $(focusId).focus();
  }

  /* This week's study time, one row per day; tap a day to edit it. */
  function renderWeekTime(now) {
    const days = C.weekDays(st, C.mondayOf(now), now);
    const t = C.timeStats(st, now);
    let rows = "", sum = 0;
    days.forEach(function (d) {
      let time = "–";
      if (!d.future) {
        const m = t.dayMin(d.key);
        sum += m;
        if (m > 0) time = fmtMS(m);
      }
      rows += "<li" + (d.isToday ? ' class="is-today"' : "") + '><button type="button" data-act="editday" data-day="' + d.key + '"' + (d.future ? " disabled" : "") + ">" +
        '<span class="d">' + esc(fmtDate(d.key, { weekday: "long" })) + ' <span class="l">' + C.pd(d.key).getDate() + "</span></span>" +
        '<span class="l num">' + (d.future ? "" : d.n + " " + word(d.n)) + "</span>" +
        '<span class="t num">' + time + "</span></button></li>";
    });
    $("weektime").innerHTML =
      "<h2>This week</h2>" +
      '<ul class="wt">' + rows + "</ul>" +
      '<div class="weeksum"><span>Study time this week <b>' + fmtDur(sum) + "</b></span><span>Days without a time use your average, " + esc(fmtMS(t.avg)) + " per lesson</span></div>";
  }

  function renderPlan(s) {
    const el = $("plan");
    if (!s.total) {
      el.innerHTML =
        "<h2>Overall goal</h2>" +
        '<div class="stats">' +
          '<div class="stat"><b class="num">' + s.totalDone + "</b><span>lessons done</span></div>" +
          '<div class="stat"><b class="num">' + s.avg7.toFixed(1) + "</b><span>a day over the last 7 days</span></div>" +
        "</div>" +
        '<p class="note">Set how many lessons you want to finish (a section, a unit or the whole course) and an optional date to see how many are left and what that takes per day.</p>' +
        '<div class="row"><button class="btn ghost" type="button" data-act="setgoal">Set an overall goal</button></div>';
      return;
    }
    let perDay = "";
    if (s.neededPerDay != null) {
      perDay = '<div class="stat ' + (s.behind ? "warn" : "good") + '"><b class="num">' + s.neededPerDay + "</b><span>a day to finish by " +
        esc(fmtDate(s.deadline, { month: "short", day: "numeric" })) + " (" + s.daysLeft + " " + (s.daysLeft === 1 ? "day" : "days") + " left)</span></div>";
    }
    let proj = "";
    if (s.remaining === 0) proj = "You've finished your goal. Time to set a new one?";
    else {
      const f1 = s.finishAtGoal, f2 = s.finishAtAvg;
      proj = "At " + s.goal + " a day you'll finish on <b>" + esc(fmtDate(C.ymd(f1))) + "</b>.";
      if (f2) proj += " At your 7-day average (" + s.avg7.toFixed(1) + " a day) it's <b>" + esc(fmtDate(C.ymd(f2))) + "</b>.";
      if (s.behind) proj += " Raise your daily goal to " + s.neededPerDay + " to make your date.";
    }
    el.innerHTML =
      "<h2>Overall goal</h2>" +
      '<div class="stats">' +
        '<div class="stat"><b class="num">' + s.totalDone + '<small style="font-size:16px;color:var(--muted)"> / ' + s.total + "</small></b><span>lessons done (" + s.totalPct + "%)</span></div>" +
        '<div class="stat"><b class="num">' + s.remaining + "</b><span>" + word(s.remaining) + " left</span></div>" +
        perDay +
      "</div>" +
      '<div class="bar" role="progressbar" aria-label="Overall goal" aria-valuemin="0" aria-valuemax="' + s.total + '" aria-valuenow="' + s.totalDone + '"><i style="width:' + s.totalPct + '%"></i></div>' +
      '<p class="note">' + proj + "</p>";
  }

  function renderView(s, now) {
    document.querySelectorAll(".tabs button").forEach(function (b) {
      const on = b.dataset.tab === ui.tab;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    $("view").setAttribute("aria-labelledby", "tab-" + ui.tab);
    $("view").innerHTML = ui.tab === "week" ? weekView(now) : ui.tab === "cal" ? calView(now) : graphView(s, now);
  }

  function weekView(now) {
    const monday = C.addDays(C.mondayOf(now), ui.weekOffset * 7);
    const days = C.weekDays(st, monday, now);
    const t = C.timeStats(st, now);
    const range = fmtDate(days[0].key, { month: "short", day: "numeric" }) + " – " + fmtDate(days[6].key, { month: "short", day: "numeric" });
    let total = 0, met = 0, mins = 0, past = 0;
    let cells = "";
    days.forEach(function (d) {
      total += d.n; if (d.met) met++; if (!d.future) { past++; mins += t.dayMin(d.key); }
      const cls = "day" + (d.met ? " met" : !d.future && !d.isToday ? " miss" : "") + (d.isToday ? " is-today" : "") + (d.future ? " future" : "");
      const id = "wd-" + d.key;
      const dmin = t.dayMin(d.key);
      const dt = dmin > 0 ? splitTime(dmin) : null;
      const dm = d.future ? "" : '<button type="button" class="dm" data-act="editday" data-day="' + d.key + '" style="background:none;border:0;padding:0;cursor:pointer">' +
        (dt ? (dt.s ? dt.m + ":" + String(dt.s).padStart(2, "0") : dt.m + " min") : "+ time") + "</button>";
      cells += '<div class="' + cls + '"><label for="' + id + '">' + esc(fmtDate(d.key, { weekday: "short" })) + " " + C.pd(d.key).getDate() + "</label>" +
        '<input id="' + id + '" type="number" min="0" max="500" inputmode="numeric" data-day="' + d.key + '" value="' + (d.key in st.log ? d.n : "") + '"' + (d.future ? " disabled" : "") + ' placeholder="0">' + dm + "</div>";
    });
    const goal = st.goal.perDay * 7;
    return '<div class="navrow"><button class="navbtn" type="button" data-act="wk" data-d="-1" aria-label="Previous week">‹</button>' +
      "<b>" + (ui.weekOffset === 0 ? "This week · " : "") + esc(range) + "</b>" +
      '<button class="navbtn" type="button" data-act="wk" data-d="1" aria-label="Next week"' + (ui.weekOffset >= 0 ? " disabled" : "") + ">›</button></div>" +
      '<div class="days">' + cells + "</div>" +
      '<div class="weeksum"><span>Lessons <b class="num">' + total + " / " + goal + "</b></span>" +
      '<span>Days on goal <b class="num">' + met + " / " + (ui.weekOffset === 0 ? past : 7) + "</b></span>" +
      "<span>Study time <b>" + fmtDur(mins) + "</b></span></div>";
  }

  function calView(now) {
    const today = C.ymd(now);
    if (!ui.calMonth) ui.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const m0 = ui.calMonth;
    const isCurrent = m0.getFullYear() === now.getFullYear() && m0.getMonth() === now.getMonth();
    const lead = (m0.getDay() + 6) % 7;
    const nDays = new Date(m0.getFullYear(), m0.getMonth() + 1, 0).getDate();
    let cells = "";
    ["M", "T", "W", "T", "F", "S", "S"].forEach(function (d) { cells += '<div class="dow" aria-hidden="true">' + d + "</div>"; });
    for (let i = 0; i < lead; i++) cells += '<div class="cd blank"></div>';
    let met = 0, counted = 0, lessons = 0;
    for (let d = 1; d <= nDays; d++) {
      const k = C.ymd(new Date(m0.getFullYear(), m0.getMonth(), d));
      const n = st.log[k] || 0;
      const future = k > today;
      lessons += n;
      if (!future) { counted++; if (n >= st.goal.perDay) met++; }
      const cls = future ? "future" : n >= st.goal.perDay ? "met" : n > 0 ? "part" : k === today ? "" : "miss";
      const label = fmtDate(k, { weekday: "long", month: "long", day: "numeric" }) + ": " + n + " " + word(n) + (n >= st.goal.perDay ? ", goal met" : "");
      cells += '<button type="button" class="cd ' + cls + (k === today ? " is-today" : "") + '" data-act="editday" data-day="' + k + '"' +
        (future ? " disabled" : "") + ' aria-label="' + esc(label) + '">' + d + (n ? "<small>" + n + "</small>" : "") + "</button>";
    }
    const title = m0.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    return '<div class="navrow"><button class="navbtn" type="button" data-act="mo" data-d="-1" aria-label="Previous month">‹</button><b>' + esc(title) + "</b>" +
      '<button class="navbtn" type="button" data-act="mo" data-d="1" aria-label="Next month"' + (isCurrent ? " disabled" : "") + ">›</button></div>" +
      '<div class="cal">' + cells + "</div>" +
      '<div class="weeksum"><span>Goal met on <b class="num">' + met + " of " + counted + "</b> days</span><span>Lessons <b class=\"num\">" + lessons + "</b></span></div>" +
      '<div class="legend"><span><i class="sw"></i>Goal met</span><span><i class="sw part"></i>Some lessons</span><span><i class="sw miss"></i>None</span><span>Tap a day to edit it</span></div>';
  }

  function niceTop(v) {
    const steps = [2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    for (const s of steps) if (v <= s * 4) return Math.ceil(v / s) * s;
    return Math.ceil(v / 100000) * 100000;
  }

  /* Draw charts at the width they are shown so their text stays readable on phones. */
  function chartWidth() { return Math.max(300, Math.min(640, $("view").clientWidth || 640)); }

  function barChart(now, n) {
    const W = chartWidth(), H = 210, pl = 30, pr = 8, pt = 14, pb = 26;
    const keys = [];
    for (let i = n - 1; i >= 0; i--) keys.push(C.ymd(C.addDays(now, -i)));
    const vals = keys.map(function (k) { return st.log[k] || 0; });
    const goal = st.goal.perDay;
    const top = niceTop(Math.max(goal * 1.25, Math.max.apply(null, vals), 1));
    const iw = W - pl - pr, ih = H - pt - pb, bw = iw / n;
    const y = function (v) { return pt + ih - (v / top) * ih; };
    let g = "";
    [0, top / 2, top].forEach(function (v) {
      g += '<line class="c-grid" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
        '<text x="' + (pl - 6) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + Math.round(v) + "</text>";
    });
    const every = Math.ceil(n / 8);
    keys.forEach(function (k, i) {
      const v = vals[i];
      const cls = v >= goal ? "met" : v > 0 ? "part" : "";
      const x = pl + i * bw + bw * 0.15, w = Math.max(1, bw * 0.7);
      const h = Math.max(v ? 2 : 0, (v / top) * ih);
      g += '<rect class="c-bar ' + cls + '" x="' + x.toFixed(1) + '" y="' + (pt + ih - h).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"><title>' +
        esc(fmtDate(k)) + ": " + v + " " + word(v) + "</title></rect>";
      if ((n - 1 - i) % every === 0) {
        const lbl = i === n - 1 ? "Today" : n <= 14 ? fmtDate(k, { weekday: "narrow" }) + C.pd(k).getDate() : fmtDate(k, { month: "numeric", day: "numeric" });
        g += '<text x="' + (pl + i * bw + bw / 2).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(lbl) + "</text>";
      }
    });
    g += '<line class="c-goal" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(goal) + '" y2="' + y(goal) + '"/>' +
      '<text class="lbl" x="' + (W - pr) + '" y="' + (y(goal) - 5) + '" text-anchor="end">goal ' + goal + "</text>";
    return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Lessons per day for the last ' + n + ' days, with your daily goal">' + g + "</svg>";
  }

  /* Lessons done over time from the start date, with the straight-line plan to the total by the deadline. */
  function progressChart(s, now) {
    const W = chartWidth(), H = 220, pl = 40, pr = 12, pt = 14, pb = 26;
    const start = C.pd(st.goal.start);
    if (start > now) return '<p class="note">Your goal starts on ' + esc(fmtDate(st.goal.start)) + ".</p>";
    const end = st.goal.deadline && C.pd(st.goal.deadline) > now ? C.pd(st.goal.deadline) : C.addDays(now, Math.max(7, Math.round(C.diffDays(start, now) * 0.25)));
    const N = Math.max(1, C.diffDays(start, end));
    const pts = [];
    let c = st.prior.lessons;
    for (let i = 0; i <= C.diffDays(start, now); i++) {
      c += st.log[C.ymd(C.addDays(start, i))] || 0;
      pts.push([i, c]);
    }
    const top = niceTop(Math.max(s.total || 0, c * 1.1, 5));
    const iw = W - pl - pr, ih = H - pt - pb;
    const x = function (i) { return pl + (i / N) * iw; };
    const y = function (v) { return pt + ih - (v / top) * ih; };
    let g = "";
    [0, top / 2, top].forEach(function (v) {
      g += '<line class="c-grid" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text x="' + (pl - 6) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + Math.round(v) + "</text>";
    });
    if (s.total) {
      g += '<line class="c-goal" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(s.total) + '" y2="' + y(s.total) + '"/>' +
        '<text class="lbl" x="' + (pl + 4) + '" y="' + (y(s.total) - 5) + '">goal ' + s.total + "</text>";
      if (st.goal.deadline) g += '<line class="c-plan" x1="' + x(0) + '" y1="' + y(st.prior.lessons) + '" x2="' + x(C.diffDays(start, C.pd(st.goal.deadline))) + '" y2="' + y(s.total) + '"><title>Even pace to your date</title></line>';
    }
    const line = pts.map(function (p) { return x(p[0]).toFixed(1) + "," + y(p[1]).toFixed(1); }).join(" ");
    const last = pts[pts.length - 1];
    g += '<polygon class="c-area" points="' + x(0) + "," + y(0) + " " + line + " " + x(last[0]).toFixed(1) + "," + y(0) + '"/>' +
      '<polyline class="c-line" points="' + line + '"/>' +
      '<circle class="c-dot" cx="' + x(last[0]).toFixed(1) + '" cy="' + y(last[1]).toFixed(1) + '" r="5"><title>' + last[1] + " lessons done</title></circle>";
    g += '<text x="' + pl + '" y="' + (H - 8) + '">' + esc(fmtDate(st.goal.start, { month: "short", day: "numeric" })) + "</text>" +
      '<text x="' + x(last[0]) + '" y="' + (H - 8) + '" text-anchor="middle">Today</text>' +
      '<text x="' + (W - pr) + '" y="' + (H - 8) + '" text-anchor="end">' + esc(fmtDate(C.ymd(end), { month: "short", day: "numeric" })) + "</text>";
    return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Lessons done since ' + esc(st.goal.start) + (s.total ? " toward a goal of " + s.total : "") + '">' + g + "</svg>";
  }

  function graphView(s, now) {
    const n = ui.graphDays;
    let sum = 0, best = 0, met = 0;
    for (let i = 0; i < n; i++) {
      const v = st.log[C.ymd(C.addDays(now, -i))] || 0;
      sum += v; best = Math.max(best, v); if (v >= st.goal.perDay) met++;
    }
    const seg = [14, 30, 90].map(function (d) {
      return '<button type="button" data-act="gdays" data-n="' + d + '" aria-pressed="' + (d === n) + '">' + d + " days</button>";
    }).join("");
    let need = "";
    if (s.total) {
      need = s.remaining === 0 ? "Goal finished" :
        s.remaining + " left" + (s.neededPerDay != null ? " · " + s.neededPerDay + " a day needed" : " · " + Math.ceil(s.remaining / s.goal) + " days at your goal");
    }
    return '<div class="ghead"><b>Lessons per day</b><span class="seg" role="group" aria-label="Range">' + seg + "</span></div>" +
      barChart(now, n) +
      '<div class="weeksum"><span>Average <b class="num">' + (sum / n).toFixed(1) + "</b> a day</span><span>Best day <b class=\"num\">" + best + "</b></span><span>On goal <b class=\"num\">" + met + " / " + n + "</b> days</span></div>" +
      '<div class="ghead"><b>' + (s.total ? "Progress toward " + s.total + " lessons" : "Lessons done") + "</b><span>" + need + "</span></div>" +
      progressChart(s, now) +
      (s.total && st.goal.deadline ? '<div class="legend"><span><i class="sw"></i>Done</span><span>- - - Even pace to your date</span></div>' : "");
  }

  function renderTime(s) {
    const t = s.time;
    const avgTxt = t.avg.toFixed(1) + " min per lesson" + (t.assumed ? " (a starting guess until you enter some minutes)" : "");
    $("timecard").innerHTML =
      "<h2>Study time</h2>" +
      '<div class="hours num">' + fmtDur(t.totalMin) + "<small>in total" + (t.estMin + st.prior.minutes > 0 ? ", including " + fmtDur(t.estMin) + " from your average" + (st.prior.minutes ? " and " + fmtDur(st.prior.minutes) + " from before" : "") : "") + "</small></div>" +
      '<div class="stats tstats">' +
        '<div class="stat"><b class="num">' + fmtDur(t.todayMin) + "</b><span>today" + (t.todayEstimated ? " (from your average)" : "") + "</span></div>" +
        '<div class="stat"><b class="num">' + fmtDur(t.weekMin) + "</b><span>this week</span></div>" +
        '<div class="stat"><b class="num">' + t.avg.toFixed(1) + "</b><span>min per lesson</span></div>" +
        '<div class="stat"><b class="num">' + (t.logged + st.prior.lessons) + "</b><span>lessons in total</span></div>" +
      "</div>" +
      '<p class="note">Days with lessons but no time entered are counted at ' + esc(avgTxt) + ". Duolingo doesn't share study time, so enter it on the Today page or by tapping a day to replace the average.</p>";
  }

  function renderDuo() {
    const d = st.duo;
    const el = $("duocard");
    if (!d.lastSync) {
      el.innerHTML = "<h2>Duolingo</h2>" +
        '<p class="note" style="margin-top:0">' + (d.username ? "Not synced yet." : "Add your Duolingo username in Settings to see your streak and XP here.") + "</p>" +
        '<div class="row"><button class="btn ghost" type="button" data-act="gosync">' + (d.username ? "Sync now" : "Connect Duolingo") + "</button></div>";
      return;
    }
    const xpToday = d.xpDay[C.ymd(new Date())];
    el.innerHTML =
      "<h2>Duolingo" + (d.username ? " · " + esc(d.username) : "") + "</h2>" +
      '<div class="duo-stats" style="margin-top:0">' +
        '<div class="stat"><b class="num">' + (d.streak == null ? "–" : d.streak) + "</b><span>day streak</span></div>" +
        '<div class="stat"><b class="num">' + (d.totalXp == null ? "–" : d.totalXp.toLocaleString()) + "</b><span>total XP</span></div>" +
        (d.courseTitle ? '<div class="stat"><b class="num">' + (d.courseXp == null ? "–" : d.courseXp.toLocaleString()) + "</b><span>" + esc(d.courseTitle) + " XP</span></div>" : "") +
        '<div class="stat"><b class="num">' + (xpToday == null ? "–" : xpToday) + "</b><span>XP today</span></div>" +
      "</div>" +
      '<p class="note">Last synced ' + esc(ago(d.lastSync)) + ".</p>";
  }

  function renderSync() {
    const d = st.duo;
    const el = $("sync");
    const focusId = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
    let status = "";
    if (ui.syncing) status = "Syncing…";
    else if (d.lastSync) status = "Last synced " + ago(d.lastSync) + ".";
    else if (!d.error) status = "Not synced yet. Everything works with typed-in values too.";
    el.innerHTML =
      "<h2>Duolingo account</h2>" +
      '<form id="syncForm" class="row" autocomplete="off">' +
        '<div class="field" style="flex:1 1 200px"><label for="duoUser">Duolingo username</label><input id="duoUser" value="' + esc(d.username) + '" placeholder="your username" autocapitalize="off" spellcheck="false"></div>' +
        '<button class="btn" type="submit"' + (ui.syncing ? " disabled" : "") + ">Sync now</button>" +
      "</form>" +
      '<p class="fine' + (d.error ? " err" : "") + '" role="status">' + esc(status) + (d.error ? " " + esc(d.error) : "") + "</p>" +
      '<details class="adv"' + (ui.advOpen ? " open" : "") + ' id="advSync"><summary>How syncing works and advanced options</summary>' +
        '<p class="fine">Duolingo has no official API. ' + (N.isNative ? "The app reads your public profile directly" : "The relay (<code>server.py</code>) reads your public profile") + ": streak, total XP and current course. " +
        "Without a login token, today's lessons are estimated as today's XP ÷ XP per lesson, and the first sync only sets the starting point. " +
        "Days you edit yourself are never overwritten by a sync.</p>" +
        '<div class="set-grid">' +
          '<div class="field"><label for="duoXpl">XP per lesson (for estimates)</label><input id="duoXpl" type="number" min="1" max="100" value="' + d.xpPerLesson + '"></div>' +
          (N.isNative ? "" : '<div class="field"><label for="duoRelay">Relay address (blank = this server)</label><input id="duoRelay" value="' + esc(d.relay) + '" placeholder="' + esc(location.origin) + '" spellcheck="false"></div>') +
          '<div class="field" style="grid-column:1/-1"><label for="duoJwt">Login token (optional, for exact lesson counts)</label><input id="duoJwt" type="password" value="' + esc(d.jwt) + '" placeholder="jwt_token cookie from duolingo.com" spellcheck="false"></div>' +
        "</div>" +
        '<p class="fine">With a token the relay can read your recent lesson history, so each lesson is counted exactly. Find it on duolingo.com in your browser: Developer tools → Application → Cookies → <code>jwt_token</code>. ' +
        "It acts like your password: it is kept only on this device, sent only to " + (N.isNative ? "Duolingo" : "your own relay") + ", and left out of backups. Leave it blank if you'd rather not.</p>" +
      "</details>";
    if (focusId && $(focusId)) $(focusId).focus();
  }

  /* ---------- sync ---------- */
  async function sync(manual) {
    if (ui.syncing || !st.duo.username) return;
    ui.syncing = true; renderSync();
    try {
      const origin = /^https?:/.test(location.protocol) ? location.origin : "";
      st = await C.syncDuolingo(st, origin, new Date(), N.isNative ? N.lookup : undefined);
      if (manual) toast("Synced with Duolingo");
    } catch (e) {
      st.duo.error = e.message;
      if (manual) toast(e.message);
    }
    ui.syncing = false;
    commit();
  }

  /* ---------- notifications ---------- */
  async function showNote(title, body, tag) {
    if (!("Notification" in window) || Notification.permission !== "granted") return false;
    const opts = { body: body, icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: tag || "daily", data: { url: "./" } };
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) await reg.showNotification(title, opts); else new Notification(title, opts);
      return true;
    } catch (e) { return false; }
  }
  function reminderTick() {
    if (N.isNative) return; // Android schedules reminders itself
    const now = new Date();
    if (!C.shouldRemind(st, now) || !("Notification" in window) || Notification.permission !== "granted") return;
    const n = C.reminderNote(C.summary(st, now));
    st.notify.lastSent = C.ymd(now);
    showNote(n.title, n.body, "daily");
    commit();
  }
  /* Lets an installed app check in the background (Chrome and Edge decide how often, usually a few times a day). */
  async function registerBackground() {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!("periodicSync" in reg)) return false;
      const p = await navigator.permissions.query({ name: "periodic-background-sync" });
      if (p.state !== "granted") return false;
      await reg.periodicSync.register("daily-check", { minInterval: 4 * 60 * 60 * 1000 });
      return true;
    } catch (e) { return false; }
  }
  async function notifyStatus() {
    const msg = $("notifyMsg");
    if (N.isNative) {
      $("exactBtn").hidden = true;
      msg.className = "fine";
      if (!st.notify.on) { msg.textContent = ""; return; }
      if ((await N.permission()) !== "granted") {
        msg.className = "fine err";
        msg.textContent = "Notifications are turned off for Lesson Tracker. Allow them in Android Settings → Apps → Lesson Tracker → Notifications.";
        return;
      }
      const exact = await N.canExact();
      $("exactBtn").hidden = exact;
      msg.textContent = "Android will remind you at " + st.notify.time + " every day, with a fresh encouragement each time." +
        (exact ? "" : " To make sure it arrives on the minute, allow exact alarms below; otherwise Android may deliver it a few minutes late.");
      return;
    }
    if (!("Notification" in window)) { msg.textContent = "This browser doesn't support notifications. On iPhone, add the app to your Home Screen first."; return; }
    if (!st.notify.on) { msg.textContent = ""; return; }
    if (Notification.permission === "denied") { msg.textContent = "Notifications are blocked for this site. Allow them in your browser's site settings."; msg.className = "fine err"; return; }
    msg.className = "fine";
    const bg = await registerBackground();
    msg.textContent = bg
      ? "You'll get a reminder around " + st.notify.time + " each day, plus a cheer when you reach your goal."
      : "You'll get a reminder at " + st.notify.time + " while the app is open. Install the app (Chrome or Edge) for reminders when it's closed.";
  }

  /* ---------- settings ---------- */
  function fillSettings() {
    $("perDay").value = st.goal.perDay;
    $("total").value = st.goal.total;
    $("start").value = st.goal.start;
    $("deadline").value = st.goal.deadline;
    $("priorL").value = st.prior.lessons;
    $("priorM").value = st.prior.minutes;
    $("notifyOn").checked = st.notify.on;
    $("notifyTime").value = st.notify.time;
  }
  async function onSettings(e) {
    const t = e.target;
    if (t.id === "notifyOn" && t.checked && N.isNative) {
      if (!(await N.requestPermission())) t.checked = false;
    } else if (t.id === "notifyOn" && t.checked && "Notification" in window && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") t.checked = false;
    }
    const prevTime = st.notify.time;
    st = C.normalize(Object.assign({}, st, {
      goal: { perDay: $("perDay").value, total: $("total").value, start: $("start").value, deadline: $("deadline").value },
      prior: { lessons: $("priorL").value, minutes: $("priorM").value },
      notify: Object.assign({}, st.notify, { on: $("notifyOn").checked, time: $("notifyTime").value || "19:00" })
    }));
    // Moving the reminder later today lets it fire again today.
    if (st.notify.time > prevTime && st.notify.lastSent === C.ymd(new Date()) && C.hhmm(new Date()) < st.notify.time) st.notify.lastSent = "";
    commit();
    fillSettings();
    if (t.id === "notifyOn" || t.id === "notifyTime") notifyStatus();
  }

  /* ---------- day dialog ---------- */
  function openDay(k) {
    const today = C.ymd(new Date());
    if (!k || k > today) return;
    ui.editing = k;
    $("dayTitle").textContent = fmtDate(k, { weekday: "long", month: "long", day: "numeric" });
    $("dayLessons").value = k in st.log ? st.log[k] : "";
    const dt = st.mins[k] ? splitTime(st.mins[k]) : null;
    $("dayMins").value = dt ? dt.m : "";
    $("daySecs").value = dt ? dt.s : "";
    const da = splitTime(C.timeStats(st, new Date()).dayMin(k)); // average-based time shown until one is entered
    $("dayMins").placeholder = da.m; $("daySecs").placeholder = da.s;
    const xp = st.duo.xpDay[k];
    $("daySrc").textContent = (st.src[k] === "sync" ? "This day was filled in by Duolingo sync. Saving makes it yours, so syncs won't change it. " : "") +
      (xp != null ? xp + " XP earned that day." : "");
    const dlg = $("dayDlg");
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
    $("dayLessons").focus();
  }

  /* ---------- toast ---------- */
  let toastTimer = 0;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3800);
  }

  /* ---------- events ---------- */
  document.addEventListener("click", function (e) {
    const b = e.target.closest("[data-act], [data-tab], [data-page]");
    if (!b) return;
    const today = C.ymd(new Date());
    if (b.dataset.page) { goPage(b.dataset.page); return; }
    if (b.dataset.tab) {
      ui.tab = b.dataset.tab; lsSet("duo-tab", ui.tab); render();
      const tb = document.querySelector('.tabs [data-tab="' + ui.tab + '"]'); if (tb) tb.focus();
      return;
    }
    switch (b.dataset.act) {
      case "plus": setDay(today, (st.log[today] || 0) + 1); commit(); break;
      case "minus": setDay(today, Math.max(0, (st.log[today] || 0) - 1)); commit(); break;
      case "wk": ui.weekOffset = Math.min(0, ui.weekOffset + Number(b.dataset.d)); render(); break;
      case "mo": ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth() + Number(b.dataset.d), 1); render(); break;
      case "gdays": ui.graphDays = Number(b.dataset.n); lsSet("duo-graph", String(ui.graphDays)); render(); break;
      case "editday": openDay(b.dataset.day); break;
      case "setgoal": goPage("settings"); $("total").focus(); $("total").select(); break;
      case "gosync": goPage("settings"); if (st.duo.username) sync(true); else $("duoUser").focus(); break;
      case "install": if (installEvt) { installEvt.prompt(); installEvt = null; $("installHint").innerHTML = ""; } break;
    }
  });
  // Arrow keys move between tabs.
  document.querySelector(".tabs").addEventListener("keydown", function (e) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const order = ["week", "cal", "graph"];
    ui.tab = order[(order.indexOf(ui.tab) + (e.key === "ArrowRight" ? 1 : 2)) % 3];
    lsSet("duo-tab", ui.tab); render();
    document.querySelector('.tabs [data-tab="' + ui.tab + '"]').focus();
  });
  // Arrow keys move along the bottom navigation bar.
  document.querySelector(".bottomnav").addEventListener("keydown", function (e) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const n = PAGES.length;
    goPage(PAGES[(PAGES.indexOf(ui.page) + (e.key === "ArrowRight" ? 1 : n - 1)) % n]);
    $("nav-" + ui.page).focus();
  });
  document.addEventListener("change", function (e) {
    const t = e.target;
    if (t.id === "todayMins" || t.id === "todaySecs") { setMins(C.ymd(new Date()), readTime($("todayMins"), $("todaySecs"))); commit(); }
    else if (t.id === "otherDay" && t.value) { openDay(t.value); t.value = ""; }
    else if (t.dataset.day && t.type === "number") { setDay(t.dataset.day, t.value); commit(); }
    else if (t.id === "duoXpl" || t.id === "duoRelay" || t.id === "duoJwt") {
      st.duo.xpPerLesson = $("duoXpl").value; st.duo.jwt = $("duoJwt").value;
      if ($("duoRelay")) st.duo.relay = $("duoRelay").value;
      st = C.normalize(st); ui.advOpen = true; commit();
    }
  });
  document.addEventListener("toggle", function (e) { if (e.target.id === "advSync") ui.advOpen = e.target.open; }, true);
  document.addEventListener("submit", function (e) {
    if (e.target.id !== "syncForm") return;
    e.preventDefault();
    const u = $("duoUser").value.trim();
    if (u !== st.duo.username) {
      // A new account starts its XP history fresh.
      st.duo = Object.assign(C.defaults(new Date()).duo, { username: u, relay: st.duo.relay, jwt: st.duo.jwt, xpPerLesson: st.duo.xpPerLesson });
    }
    if (!u) { commit(); return; }
    sync(true);
  });
  $("setform").addEventListener("change", onSettings);
  $("dayDlg").addEventListener("close", function () {
    if ($("dayDlg").returnValue === "save" && ui.editing) {
      setDay(ui.editing, $("dayLessons").value, readTime($("dayMins"), $("daySecs")));
      commit();
    }
    ui.editing = null;
  });
  $("testNote").addEventListener("click", async function () {
    if (N.isNative) {
      if ((await N.permission()) !== "granted" && !(await N.requestPermission())) {
        $("notifyMsg").textContent = "Notifications are turned off for Lesson Tracker in Android Settings."; return;
      }
      N.testNotification(st);
      return;
    }
    if (!("Notification" in window)) { $("notifyMsg").textContent = "This browser doesn't support notifications."; return; }
    if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") {
      $("notifyMsg").textContent = "Notifications are blocked for this site."; return;
    }
    const n = C.reminderNote(C.summary(st, new Date()));
    showNote(n.title, n.body, "test");
  });
  $("pinWidget").addEventListener("click", async function () {
    const ok = await N.pinWidget();
    $("widgetMsg").textContent = ok
      ? "Confirm on the next screen to place the widget."
      : "Your launcher can't add it automatically. Long-press your home screen, choose Widgets, and find Lesson Tracker.";
  });
  $("exactBtn").addEventListener("click", async function () {
    await N.openExactSetting();
    N.onSave(st);
    notifyStatus();
  });
  $("exportBtn").addEventListener("click", async function () {
    const copy = JSON.parse(JSON.stringify(st));
    copy.duo.jwt = "";
    if (N.isNative) {
      // Downloads don't work inside the Android WebView, so the backup goes to the clipboard.
      try {
        await navigator.clipboard.writeText(JSON.stringify(copy));
        $("dataMsg").textContent = "Backup copied. Paste it into a note or email to keep it safe; save it as a .json file to import later.";
      } catch (e) { $("dataMsg").textContent = "Couldn't copy the backup."; }
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(copy, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = "lesson-tracker-" + C.ymd(new Date()) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  $("importFile").addEventListener("change", async function (e) {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || typeof data !== "object" || !data.goal) throw new Error("not a backup");
      const jwt = st.duo.jwt;
      st = C.normalize(data);
      st.duo.jwt = jwt;
      commit(); fillSettings();
      $("dataMsg").textContent = "Backup imported.";
    } catch (err) { $("dataMsg").textContent = "That file isn't a Lesson Tracker backup."; }
  });
  let resetArmed = 0;
  $("resetBtn").addEventListener("click", function (e) {
    if (Date.now() - resetArmed > 4000) {
      resetArmed = Date.now();
      e.target.textContent = "Tap again to erase";
      setTimeout(function () { e.target.textContent = "Erase everything"; }, 4000);
      return;
    }
    st = C.normalize(null);
    commit(); fillSettings();
    e.target.textContent = "Erase everything";
    $("dataMsg").textContent = "Everything on this device was erased.";
  });

  let installEvt = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    installEvt = e;
    $("installHint").innerHTML = '<button class="btn ghost" type="button" data-act="install" style="min-height:32px">Install app</button>';
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    adoptNewer().then(function () {
      render();
      if (st.duo.username && Date.now() - st.duo.lastSync > AUTO_SYNC_MS) sync(false);
    });
  });

  /* ---------- boot ---------- */
  if (N.isNative) {
    $("widgetBox").hidden = false;
    N.onResume(function () {
      mergeWidgetAdds().then(function () {
        render();
        if (st.duo.username && Date.now() - st.duo.lastSync > AUTO_SYNC_MS) sync(false);
      });
    });
    mergeWidgetAdds();
  } else if ("serviceWorker" in navigator && /^https?:/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").then(function () { mirror(); notifyStatus(); }).catch(function () {});
    navigator.serviceWorker.addEventListener("message", function (e) {
      if (e.data && e.data.type === "state-changed") adoptNewer();
    });
  }
  fillSettings();
  render();
  adoptNewer();
  notifyStatus();
  if (st.duo.username && Date.now() - st.duo.lastSync > AUTO_SYNC_MS) sync(false);
  setInterval(function () { reminderTick(); }, 60 * 1000);
  setTimeout(reminderTick, 3000);
  let resizeTimer = 0;
  window.addEventListener("resize", function () {
    if (ui.page !== "progress" || ui.tab !== "graph") return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });
  // Roll the page over at midnight.
  let lastDay = C.ymd(new Date());
  setInterval(function () { const d = C.ymd(new Date()); if (d !== lastDay) { lastDay = d; render(); } }, 60 * 1000);
})();
