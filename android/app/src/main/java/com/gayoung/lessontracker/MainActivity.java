package com.gayoung.lessontracker;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LessonWidgetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
