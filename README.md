# Lesson Tracker for Duolingo

An installable web app (PWA) that tracks your Duolingo lessons against a daily goal:

- **Today**: lessons done vs. your goal (+/− buttons), minutes studied, and an encouraging note.
- **Overall goal**: lessons left toward a total (a section, or the whole course), lessons per day needed to finish by a date, and projected finish dates.
- **Week / Calendar / Graph** tabs: the week's days (editable), a month calendar showing which days hit the goal, and charts of lessons per day and progress toward your total.
- **Study time**: total, today and this week. Days without minutes are estimated from your average per lesson.
- **Duolingo sync** through a small relay: streak, total XP, course and estimated lessons.
- **Daily reminder** notifications with encouragement, plus a cheer when you reach your goal.
- **Windows 11 widget** showing today's progress, with a "+1 lesson" button.

Data stays on your device (localStorage). Use Export and Import under Settings to back it up.

## Run it

Requires Python 3.10+. No other dependencies.

```sh
python server.py
```

Open http://localhost:8787, then use **Install app** in the footer or the browser's install button.

## Android app

The same `app/` folder is packaged as a native Android app with [Capacitor](https://capacitorjs.com). On Android:

- **Reminders are scheduled by Android itself**, three weeks ahead, and rebuilt on every change, so they arrive even when the app is closed. Today's reminder reflects what you've already logged. For on-the-minute delivery, tap **Allow exact reminder times** in Settings.
- **Home-screen widget**: today's lessons, a progress bar, an encouragement, and a **+1** button. Add it from Settings → **Add widget to home screen**, or long-press the home screen → Widgets → Lesson Tracker.
- **Duolingo sync calls Duolingo directly**, so no relay server is needed.
- **Backups**: Export copies the backup to the clipboard, because downloads don't work inside the app.

Requires Node.js 22+ and Android Studio.

```sh
npm install
npm run sync      # copy app/ into the Android project (run after every web change)
npm run open      # open in Android Studio, then Run ▶ on a phone or emulator
```

Build an installable APK from the command line with `cd android && ./gradlew assembleDebug`. The file lands in `android/app/build/outputs/apk/debug/app-debug.apk`; copy it to your phone and open it to install (allow "install unknown apps" when asked). For the Play Store, build a signed release bundle in Android Studio (Build → Generate Signed App Bundle).

Native code lives in `android/app/src/main/java/com/gayoung/lessontracker/`:
`LessonWidgetProvider.java` (the widget) and `LessonWidgetPlugin.java` (lets the web app refresh and pin it).
The web side of the bridge is `app/native.js`.

## How Duolingo sync works

Duolingo has no official API, and its unofficial endpoints block browser requests, so `server.py` relays them.

| What you give it | What it gets |
|---|---|
| Username only | Streak, total XP and current course. Today's lessons are estimated as today's XP ÷ "XP per lesson" (default 15). The first sync only sets a starting point. |
| Username + login token (optional) | Your recent lesson history (`xpGains`), so each lesson is counted exactly. |

Days you edit by hand are never overwritten by a sync. Duolingo doesn't expose study time, so enter minutes yourself.

The token is the `jwt_token` cookie from duolingo.com. It acts like a password: it stays on your device, goes only to your relay in a header (never in a URL or log), and is left out of exported backups.

These endpoints are unofficial and may change or stop working. Manual entry always works.

## Notifications and the widget: what to expect

- **Reminders while the app is open** fire at your chosen time.
- **Reminders while it's closed** use Periodic Background Sync, which needs the installed app in Chrome or Edge. The browser decides exactly when it runs, usually a few times a day, so a reminder can arrive later than the time you set. Firefox and Safari don't support it. On iPhone, add the app to your Home Screen to allow notifications.
- **Widget**: Windows 11 widgets for PWAs work with the app installed from **Edge**. Open the Widgets board (Win + W), choose **+**, and add "Today's lesson goal". Phone home-screen widgets aren't available to web apps.

## Use it on your phone

Your phone needs to reach the server over HTTPS (service workers require it, except on `localhost`). Either:

- deploy `server.py` to any Python host (Render, Fly.io, Railway, a VPS) with `HOST=0.0.0.0 PORT=<port> python server.py`, or
- keep it on your PC and expose it with a tunnel such as `cloudflared tunnel --url http://localhost:8787`.

You can also host the `app/` folder anywhere static (for example GitHub Pages) and set **Relay address** under the sync card's advanced options to wherever `server.py` runs.

## Tests

```sh
python -m unittest discover -s tests      # relay
```

Open `tests/core_test.html` in a browser for the app logic tests. Headless:

```sh
chrome --headless --allow-file-access-from-files --dump-dom tests/core_test.html
```

## Layout

```
server.py              relay + static server
app/index.html         page shell
app/core.js            shared logic: state, goals, streaks, time, encouragement, sync merge, widget data
app/app.js             UI, saving, sync, reminders
app/native.js          Android glue: native reminders, widget data, direct sync (no-op on the web)
app/vendor/            Capacitor runtime, copied from node_modules by `npm run sync`
android/               Capacitor Android project (widget + bridge plugin in Java)
app/sw.js              offline cache, background reminders, Windows widget
app/widgets/           Adaptive Card template for the widget
tests/                 relay tests (Python), core logic tests (browser)
```
