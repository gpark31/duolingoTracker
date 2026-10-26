package com.gayoung.lessontracker;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Home-screen widget: today's lessons against the daily goal, with a +1 button.
 *
 * The web app writes a summary under "widget" in the Capacitor Preferences store (SharedPreferences
 * "CapacitorStorage"). Taps on +1 are queued under "widgetAdds" as {"YYYY-MM-DD": count}; the app merges and
 * clears them the next time it opens, so the widget never has to edit the app's own data.
 */
public class LessonWidgetProvider extends AppWidgetProvider {

    static final String ACTION_ADD = "com.gayoung.lessontracker.widget.ADD_LESSON";
    private static final String PREFS = "CapacitorStorage";
    private static final String KEY_WIDGET = "widget";
    private static final String KEY_ADDS = "widgetAdds";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) manager.updateAppWidget(id, buildViews(context));
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (ACTION_ADD.equals(intent.getAction())) {
            addLesson(context);
            updateAll(context);
            return;
        }
        super.onReceive(context, intent);
    }

    /** Redraws every placed widget. Called by the app after each save, and after a +1 tap. */
    static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, LessonWidgetProvider.class));
        if (ids.length == 0) return;
        RemoteViews views = buildViews(context);
        for (int id : ids) manager.updateAppWidget(id, views);
    }

    private static String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    private static JSONObject readJson(SharedPreferences prefs, String key) {
        String raw = prefs.getString(key, null);
        if (raw == null) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static synchronized void addLesson(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject adds = readJson(prefs, KEY_ADDS);
        String day = today();
        try {
            adds.put(day, adds.optInt(day, 0) + 1);
        } catch (JSONException e) {
            return;
        }
        prefs.edit().putString(KEY_ADDS, adds.toString()).apply();
    }

    private static RemoteViews buildViews(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject w = readJson(prefs, KEY_WIDGET);
        String day = today();
        int pending = readJson(prefs, KEY_ADDS).optInt(day, 0);
        boolean fresh = day.equals(w.optString("date"));
        boolean hasData = w.has("goalN");
        int goal = Math.max(1, w.optInt("goalN", 5));
        int done = (fresh ? w.optInt("doneN", 0) : 0) + pending;

        String message;
        if (!hasData) {
            message = context.getString(R.string.widget_empty);
        } else if (fresh && pending == 0) {
            message = w.optString("message");
        } else if (done >= goal) {
            message = "Goal reached. Nice work!";
        } else if (done > 0) {
            int left = goal - done;
            message = left + (left == 1 ? " more lesson" : " more lessons") + " to hit today’s goal.";
        } else {
            message = "Your " + goal + " lessons are waiting. Even five minutes counts.";
        }
        String footer = hasData ? w.optString("streak") + " · " + w.optString("remaining") : "";

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_lesson);
        views.setTextViewText(R.id.widget_done, String.valueOf(done));
        views.setTextViewText(R.id.widget_goal, "/ " + goal + (goal == 1 ? " lesson" : " lessons"));
        views.setProgressBar(R.id.widget_progress, goal, Math.min(done, goal), false);
        views.setTextViewText(R.id.widget_message, message);
        views.setTextViewText(R.id.widget_footer, footer);

        Intent add = new Intent(context, LessonWidgetProvider.class).setAction(ACTION_ADD);
        views.setOnClickPendingIntent(R.id.widget_add, PendingIntent.getBroadcast(
            context, 1, add, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        views.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(
            context, 2, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return views;
    }
}
