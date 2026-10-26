/* Shared by the page and the service worker: the state shape, date helpers, and every number the UI,
   notifications and widget show. No DOM access here, so the service worker can importScripts() it. */
(function (root) {
  "use strict";

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const DEFAULT_MIN_PER_LESSON = 3.5;

  /* ---------- dates (always local time, keyed as YYYY-MM-DD) ---------- */
  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function pd(s) { const p = s.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function diffDays(a, b) { return Math.round((pd(ymd(b)) - pd(ymd(a))) / 864e5); }
  function mondayOf(d) { return addDays(d, -((d.getDay() + 6) % 7)); }
  function hhmm(d) { return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }

  /* ---------- state ---------- */
  function defaults(now) {
    return {
      v: 1,
      goal: { perDay: 5, total: 0, start: ymd(now), deadline: "" },
      prior: { lessons: 0, minutes: 0 },
      log: {},   // date -> lessons
      src: {},   // date -> "manual" | "sync" (synced values never overwrite manual ones)
      mins: {},  // date -> minutes studied
      duo: {
        username: "", relay: "", jwt: "", xpPerLesson: 15, lastSync: 0, error: "",
        streak: null, totalXp: null, courseTitle: "", courseXp: null,
        snaps: {}, // date -> totalXp at the last sync that day
        xpDay: {}, // date -> XP earned that day
        dayBase: null // { date, xp }: total XP that today's gain is measured from
      },
      notify: { on: false, time: "19:00", lastSent: "", cheered: "" },
      updatedAt: 0
    };
  }

  function int(v, lo, hi, dflt) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  }
  /* Study time per day, in minutes, kept to the second. */
  function cleanMins(m) {
    const out = {};
    if (m && typeof m === "object") {
      Object.keys(m).forEach(function (k) {
        const n = Math.round(Number(m[k]) * 60) / 60;
        if (DATE_RE.test(k) && Number.isFinite(n) && n > 0 && n <= 1440) out[k] = n;
      });
    }
    return out;
  }
  function cleanMap(m, lo, hi) {
    const out = {};
    if (m && typeof m === "object") {
      Object.keys(m).forEach(function (k) {
        const n = Math.round(Number(m[k]));
        if (DATE_RE.test(k) && Number.isFinite(n) && n >= lo && n <= hi) out[k] = n;
      });
    }
    return out;
  }
  function str(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }

  function normalize(raw, now) {
    const d = defaults(now || new Date());
    const r = raw && typeof raw === "object" ? raw : {};
    const g = Object.assign({}, d.goal, r.goal);
    const p = Object.assign({}, d.prior, r.prior);
    const du = Object.assign({}, d.duo, r.duo);
    const no = Object.assign({}, d.notify, r.notify);
    const s = {
      v: 1,
      goal: {
        perDay: int(g.perDay, 1, 100, 5),
        total: int(g.total, 0, 100000, 0),
        start: DATE_RE.test(g.start) ? g.start : d.goal.start,
        deadline: DATE_RE.test(g.deadline) ? g.deadline : ""
      },
      prior: { lessons: int(p.lessons, 0, 100000, 0), minutes: int(p.minutes, 0, 1000000, 0) },
      log: cleanMap(r.log, 0, 500),
      src: {},
      mins: cleanMins(r.mins),
      duo: {
        username: str(du.username, 40), relay: str(du.relay, 300), jwt: str(du.jwt, 4000),
        xpPerLesson: int(du.xpPerLesson, 1, 100, 15), lastSync: Number(du.lastSync) || 0, error: str(du.error, 200),
        streak: du.streak == null ? null : int(du.streak, 0, 100000, null),
        totalXp: du.totalXp == null ? null : int(du.totalXp, 0, 1e9, null),
        courseTitle: str(du.courseTitle, 80),
        courseXp: du.courseXp == null ? null : int(du.courseXp, 0, 1e9, null),
        snaps: cleanMap(du.snaps, 0, 1e9), xpDay: cleanMap(du.xpDay, 0, 1e6),
        dayBase: du.dayBase && DATE_RE.test(du.dayBase.date) && Number.isFinite(Number(du.dayBase.xp))
          ? { date: du.dayBase.date, xp: Number(du.dayBase.xp) } : null
      },
      notify: {
        on: !!no.on,
        time: /^\d{2}:\d{2}$/.test(no.time) ? no.time : "19:00",
        lastSent: DATE_RE.test(no.lastSent) ? no.lastSent : "",
        cheered: DATE_RE.test(no.cheered) ? no.cheered : ""
      },
      updatedAt: Number(r.updatedAt) || 0
    };
    if (r.src && typeof r.src === "object") {
      Object.keys(r.src).forEach(function (k) {
        if (k in s.log && (r.src[k] === "manual" || r.src[k] === "sync")) s.src[k] = r.src[k];
      });
    }
    return s;
  }

  /* ---------- numbers ---------- */
  function lessonsOn(st, k) { return st.log[k] || 0; }

  function weekDays(st, monday, now) {
    const today = ymd(now);
    const out = [];
    for (let i = 0; i < 7; i++) {
      const k = ymd(addDays(monday, i));
      const n = lessonsOn(st, k);
      out.push({ key: k, n: n, mins: st.mins[k] || 0, met: n >= st.goal.perDay, future: k > today, isToday: k === today });
    }
    return out;
  }

  /* Study time. The minutes-per-lesson average comes only from days where minutes were entered;
     lessons on days without minutes are priced at that average but never feed it. */
  function timeStats(st, now) {
    let timedMin = 0, timedN = 0, untimedN = 0, loneMin = 0, logged = 0;
    Object.keys(st.log).forEach(function (k) {
      const n = st.log[k];
      logged += n;
      if (st.mins[k] > 0) { timedMin += st.mins[k]; timedN += n; } else untimedN += n;
    });
    Object.keys(st.mins).forEach(function (k) { if (!(st.log[k] > 0)) loneMin += st.mins[k]; });
    const assumed = timedN === 0;
    const avg = assumed ? DEFAULT_MIN_PER_LESSON : timedMin / timedN;
    const dayMin = function (k) { return st.mins[k] > 0 ? st.mins[k] : lessonsOn(st, k) * avg; };
    const monday = mondayOf(now);
    let weekMin = 0;
    for (let i = 0; i < 7; i++) weekMin += dayMin(ymd(addDays(monday, i)));
    return {
      avg: avg, assumed: assumed, logged: logged,
      actualMin: timedMin + loneMin, estMin: untimedN * avg,
      totalMin: st.prior.minutes + timedMin + loneMin + untimedN * avg,
      todayMin: dayMin(ymd(now)), todayEstimated: !(st.mins[ymd(now)] > 0) && lessonsOn(st, ymd(now)) > 0,
      weekMin: weekMin, dayMin: dayMin
    };
  }

  function summary(st, now) {
    now = now || new Date();
    const today = ymd(now), per = st.goal.perDay;
    const done = lessonsOn(st, today);

    // Goal streak: consecutive days on goal, ending today if today is met, else yesterday.
    let goalStreak = 0, d = done >= per ? now : addDays(now, -1);
    while (goalStreak < 3650 && lessonsOn(st, ymd(d)) >= per) { goalStreak++; d = addDays(d, -1); }

    let sinceStart = 0;
    Object.keys(st.log).forEach(function (k) { if (k >= st.goal.start) sinceStart += st.log[k]; });
    const totalDone = st.prior.lessons + sinceStart;
    const total = st.goal.total;
    const remaining = total ? Math.max(0, total - totalDone) : null;

    // Lessons per day to finish by the deadline. Counted from before today's lessons, with today as a
    // full day, so the number holds steady while you log today.
    let daysLeft = null, neededPerDay = null;
    if (st.goal.deadline) {
      daysLeft = Math.max(0, diffDays(now, pd(st.goal.deadline)) + 1);
      if (total) {
        const leftBeforeToday = Math.max(0, total - (totalDone - (today >= st.goal.start ? done : 0)));
        neededPerDay = daysLeft ? Math.ceil(leftBeforeToday / daysLeft) : leftBeforeToday;
      }
    }

    let sum7 = 0;
    for (let i = 1; i <= 7; i++) sum7 += lessonsOn(st, ymd(addDays(now, -i)));
    const avg7 = sum7 / 7;

    const finishAt = function (pace) {
      if (remaining == null) return null;
      if (remaining === 0) return now;
      if (!(pace > 0)) return null;
      return addDays(now, Math.max(0, Math.ceil(remaining / pace) - (done < per ? 1 : 0)));
    };

    const week = weekDays(st, mondayOf(now), now);
    return {
      today: today, done: done, goal: per, left: Math.max(0, per - done), extra: Math.max(0, done - per),
      pct: Math.min(100, Math.round((done / per) * 100)), met: done >= per,
      goalStreak: goalStreak, duoStreak: st.duo.streak,
      totalDone: totalDone, total: total, remaining: remaining,
      totalPct: total ? Math.min(100, Math.round((totalDone / total) * 100)) : null,
      daysLeft: daysLeft, neededPerDay: neededPerDay, deadline: st.goal.deadline,
      behind: neededPerDay != null && neededPerDay > per,
      avg7: avg7, finishAtGoal: finishAt(per), finishAtAvg: finishAt(avg7),
      week: week,
      weekDone: week.reduce(function (a, x) { return a + x.n; }, 0),
      weekGoal: per * 7,
      weekMet: week.filter(function (x) { return x.met; }).length,
      time: timeStats(st, now)
    };
  }

  /* ---------- encouragement ---------- */
  function pick(list, seed) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
    return list[(h >>> 0) % list.length];
  }
  function lessonWord(n) { return n === 1 ? "lesson" : "lessons"; }

  function encourage(s, kind) {
    const seed = s.today + (kind || "");
    let line;
    if (s.met && s.extra > 0) {
      line = pick([
        "You beat today's goal by " + s.extra + ". That's extra credit.",
        s.extra + " past your goal today. Future you says thanks.",
        "Goal smashed, plus " + s.extra + " more. Great day."
      ], seed);
    } else if (s.met) {
      line = pick([
        "Today's goal is done. Nice work!",
        "All " + s.goal + " lessons done. Enjoy the rest of your day.",
        "Goal reached. Small steps every day add up."
      ], seed);
    } else if (s.done > 0) {
      line = pick([
        s.left + " more " + lessonWord(s.left) + " to hit today's goal. You're " + s.pct + "% there.",
        "Nice progress. Just " + s.left + " more today.",
        "Good start! Finish " + s.left + " more and today's done."
      ], seed);
    } else {
      line = pick([
        "One short lesson is all it takes to get going. Start one now?",
        "Your " + s.goal + " lessons are waiting. Even five minutes counts.",
        "A little practice today beats a lot tomorrow. Let's go!",
        "Keep the habit alive: open a lesson and see where it takes you."
      ], seed);
    }
    if (s.goalStreak >= 3) line += " " + s.goalStreak + " days in a row on goal.";
    if (s.behind) line += " To finish by your date you need " + s.neededPerDay + " a day.";
    return line;
  }

  function reminderNote(s) {
    if (s.met) return { title: "Goal done for today", body: encourage(s, "note") };
    const streak = s.duoStreak ? " Keep your " + s.duoStreak + "-day streak going." : "";
    return {
      title: s.done ? s.left + " " + lessonWord(s.left) + " to go today" : "Time for today's lessons",
      body: encourage(s, "note") + streak
    };
  }

  function shouldRemind(st, now) {
    return st.notify.on && st.notify.lastSent !== ymd(now) && hhmm(now) >= st.notify.time;
  }

  /* ---------- Windows widget ---------- */
  function widgetData(st, now) {
    const s = summary(st, now || new Date());
    const filled = Math.round((Math.min(s.done, s.goal) / s.goal) * 10);
    return {
      title: "Today's Duolingo goal",
      done: String(s.done), goal: String(s.goal),
      bar: "█".repeat(filled) + "░".repeat(10 - filled),
      status: s.met ? "Goal reached" : s.left + " " + lessonWord(s.left) + " to go",
      message: encourage(s, "widget"),
      streak: s.duoStreak ? s.duoStreak + "-day streak" : s.goalStreak + " days on goal",
      remaining: s.remaining == null ? "Set a total goal in the app" : s.remaining + " lessons left overall"
    };
  }

  /* ---------- Duolingo sync ---------- */
  /* r is the relay's response: { username, streak, totalXp, courseTitle, courseXp, gains: [{t, xp}] | null }.
     With gains (needs the optional login token) each XP event counts as a lesson on its local day.
     Without them, today's lessons are estimated from XP gained since the last sync before today. */
  function mergeSync(st, r, now) {
    now = now || new Date();
    const s = normalize(JSON.parse(JSON.stringify(st)), now);
    const today = ymd(now);
    const setSynced = function (k, n) {
      if (s.src[k] === "manual") return;
      s.log[k] = n;
      s.src[k] = "sync";
    };
    s.duo.streak = r.streak == null ? null : r.streak;
    s.duo.totalXp = r.totalXp == null ? null : r.totalXp;
    s.duo.courseTitle = r.courseTitle || "";
    s.duo.courseXp = r.courseXp == null ? null : r.courseXp;
    s.duo.lastSync = now.getTime();
    s.duo.error = r.gainsError || "";

    if (Array.isArray(r.gains) && r.gains.length) {
      const byDay = {}, xpByDay = {};
      r.gains.forEach(function (g) {
        if (!(g.t > 0)) return;
        const k = ymd(new Date(g.t * 1000));
        xpByDay[k] = (xpByDay[k] || 0) + (g.xp || 0);
        if ((g.xp || 0) > 0) byDay[k] = (byDay[k] || 0) + 1;
      });
      Object.keys(xpByDay).forEach(function (k) {
        s.duo.xpDay[k] = xpByDay[k];
        if (k <= today) setSynced(k, byDay[k] || 0);
      });
    } else if (r.totalXp != null) {
      // Today's base is yesterday's last snapshot when there is one. After a longer gap the XP can't be split
      // across the missed days, so the base becomes the first total seen today.
      const prev = Object.keys(s.duo.snaps).filter(function (k) { return k < today; }).sort().pop();
      let base;
      if (prev && diffDays(pd(prev), now) === 1) base = s.duo.snaps[prev];
      else if (s.duo.dayBase && s.duo.dayBase.date === today) base = s.duo.dayBase.xp;
      else base = r.totalXp;
      s.duo.dayBase = { date: today, xp: base };
      const xp = Math.max(0, r.totalXp - base);
      s.duo.xpDay[today] = xp;
      if (xp > 0 || prev) setSynced(today, Math.round(xp / s.duo.xpPerLesson));
    }
    if (r.totalXp != null) s.duo.snaps[today] = r.totalXp;
    // Keep only the last 60 snapshots.
    const keys = Object.keys(s.duo.snaps).sort();
    keys.slice(0, Math.max(0, keys.length - 60)).forEach(function (k) { delete s.duo.snaps[k]; });
    return s;
  }

  function relayUrl(st, origin) {
    const base = (st.duo.relay || origin || "").replace(/\/+$/, "");
    return base + "/api/duolingo?username=" + encodeURIComponent(st.duo.username);
  }

  /* Runs in the page or the service worker. Resolves to the merged state, or throws with a readable message.
     lookup(username, token), when given (the Android app), calls Duolingo directly instead of the relay. */
  async function syncDuolingo(st, origin, now, lookup) {
    if (!st.duo.username) throw new Error("Add your Duolingo username first.");
    if (lookup) return mergeSync(st, await lookup(st.duo.username, st.duo.jwt || null), now);
    const headers = st.duo.jwt ? { "X-Duo-Token": st.duo.jwt } : {};
    let res;
    try {
      res = await fetch(relayUrl(st, origin), { headers: headers, cache: "no-store" });
    } catch (e) {
      throw new Error("Couldn't reach the relay. Is server.py running?");
    }
    let body = null;
    try { body = await res.json(); } catch (e) { /* fall through */ }
    if (!res.ok) throw new Error((body && body.error) || "Relay error " + res.status);
    return mergeSync(st, body, now);
  }

  root.DuoCore = {
    ymd: ymd, pd: pd, addDays: addDays, diffDays: diffDays, mondayOf: mondayOf, hhmm: hhmm,
    defaults: defaults, normalize: normalize, summary: summary, weekDays: weekDays, timeStats: timeStats,
    encourage: encourage, reminderNote: reminderNote, shouldRemind: shouldRemind, widgetData: widgetData,
    mergeSync: mergeSync, syncDuolingo: syncDuolingo, lessonWord: lessonWord
  };
})(typeof self !== "undefined" ? self : this);
