package com.coincropper.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SlabScannerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
