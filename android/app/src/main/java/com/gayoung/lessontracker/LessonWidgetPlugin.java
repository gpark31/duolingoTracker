package com.gayoung.lessontracker;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Widget bridge for app/native.js: redraw the widget after a save, and ask the launcher to place it. */
@CapacitorPlugin(name = "LessonWidget")
public class LessonWidgetPlugin extends Plugin {

    @PluginMethod
    public void refresh(PluginCall call) {
        LessonWidgetProvider.updateAll(getContext());
        call.resolve();
    }

    @PluginMethod
    public void pin(PluginCall call) {
        boolean requested = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AppWidgetManager manager = AppWidgetManager.getInstance(getContext());
            if (manager.isRequestPinAppWidgetSupported()) {
                requested = manager.requestPinAppWidget(
                    new ComponentName(getContext(), LessonWidgetProvider.class), null, null);
            }
        }
        JSObject result = new JSObject();
        result.put("requested", requested);
        call.resolve(result);
    }
}
