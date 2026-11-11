package com.coincropper.app;

import android.Manifest;
import android.graphics.Color;
import android.graphics.Point;
import android.media.Image;
import android.util.Size;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ExperimentalGetImage;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Live slab scanner: shows the back camera behind the (transparent) web view and,
 * on every frame, runs ML Kit barcode scanning and text recognition.  Each frame
 * is sent to the page as a "frame" event:
 *
 *   { width, height,            // analysed image size, upright
 *     view: {x, y, w, h},       // camera preview rect relative to the web view, px
 *     barcodes: [{raw, corners:[[x,y]...]}],
 *     lines:    [{text, block, corners:[[x,y]...]}],  // null on frames without OCR
 *   }
 *
 * Corner points are in image pixels; the page maps them onto the screen.
 */
@CapacitorPlugin(name = "SlabScanner", permissions = { @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera") })
public class SlabScannerPlugin extends Plugin implements ImageAnalysis.Analyzer {

    private PreviewView previewView;
    private ProcessCameraProvider provider;
    private Camera camera;
    private BarcodeScanner barcodeScanner;
    private TextRecognizer textRecognizer;
    private ExecutorService executor;
    private volatile boolean running = false;
    private volatile boolean ocrEnabled = true;
    private volatile int[] viewRect = new int[] { 0, 0, 0, 0 };
    private long frame = 0;

    @PluginMethod
    public void start(PluginCall call) {
        ocrEnabled = call.getBoolean("ocr", true);
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        startCamera(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) startCamera(call);
        else call.reject("Camera permission was denied");
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running = false;
        getActivity().runOnUiThread(() -> {
            if (provider != null) provider.unbindAll();
            if (previewView != null) {
                ((ViewGroup) previewView.getParent()).removeView(previewView);
                previewView = null;
            }
            camera = null;
            call.resolve();
        });
    }

    @PluginMethod
    public void setTorch(PluginCall call) {
        boolean on = call.getBoolean("on", false);
        if (camera == null) {
            call.reject("Camera not started");
            return;
        }
        camera.getCameraControl().enableTorch(on);
        call.resolve();
    }

    @PluginMethod
    public void setOcr(PluginCall call) {
        ocrEnabled = call.getBoolean("on", true);
        call.resolve();
    }

    private void startCamera(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (barcodeScanner == null) {
                    barcodeScanner = BarcodeScanning.getClient(
                        new BarcodeScannerOptions.Builder()
                            .setBarcodeFormats(
                                Barcode.FORMAT_CODE_128,
                                Barcode.FORMAT_QR_CODE,
                                Barcode.FORMAT_CODE_39,
                                Barcode.FORMAT_CODE_93,
                                Barcode.FORMAT_DATA_MATRIX,
                                Barcode.FORMAT_PDF417,
                                Barcode.FORMAT_ITF
                            )
                            .build()
                    );
                }
                if (textRecognizer == null) textRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                if (executor == null) executor = Executors.newSingleThreadExecutor();

                WebView webView = getBridge().getWebView();
                webView.setBackgroundColor(Color.TRANSPARENT);
                if (previewView == null) {
                    previewView = new PreviewView(getActivity());
                    previewView.setLayoutParams(
                        new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    );
                    previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
                    previewView.setBackgroundColor(Color.BLACK);
                    ((ViewGroup) webView.getParent()).addView(previewView, 0);
                    View.OnLayoutChangeListener l = (v, a, b, c, d, e, f, g, h) -> updateViewRect();
                    previewView.addOnLayoutChangeListener(l);
                    webView.addOnLayoutChangeListener(l);
                }

                ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(getContext());
                future.addListener(
                    () -> {
                        try {
                            provider = future.get();
                            provider.unbindAll();
                            Preview preview = new Preview.Builder().build();
                            preview.setSurfaceProvider(previewView.getSurfaceProvider());
                            ResolutionSelector selector = new ResolutionSelector.Builder()
                                .setResolutionStrategy(
                                    new ResolutionStrategy(new Size(1920, 1080), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)
                                )
                                .build();
                            ImageAnalysis analysis = new ImageAnalysis.Builder()
                                .setResolutionSelector(selector)
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build();
                            analysis.setAnalyzer(executor, this);
                            camera = provider.bindToLifecycle(
                                (LifecycleOwner) getActivity(),
                                CameraSelector.DEFAULT_BACK_CAMERA,
                                preview,
                                analysis
                            );
                            running = true;
                            updateViewRect();
                            JSObject result = new JSObject();
                            result.put("torch", camera.getCameraInfo().hasFlashUnit());
                            call.resolve(result);
                        } catch (Exception e) {
                            call.reject("Could not start camera: " + e.getMessage(), e);
                        }
                    },
                    ContextCompat.getMainExecutor(getContext())
                );
            } catch (Exception e) {
                call.reject("Could not start camera: " + e.getMessage(), e);
            }
        });
    }

    private void updateViewRect() {
        if (previewView == null) return;
        int[] p = new int[2];
        int[] w = new int[2];
        previewView.getLocationOnScreen(p);
        getBridge().getWebView().getLocationOnScreen(w);
        viewRect = new int[] { p[0] - w[0], p[1] - w[1], previewView.getWidth(), previewView.getHeight() };
    }

    @Override
    @OptIn(markerClass = ExperimentalGetImage.class)
    public void analyze(@NonNull ImageProxy proxy) {
        Image image = proxy.getImage();
        if (image == null || !running) {
            proxy.close();
            return;
        }
        int rotation = proxy.getImageInfo().getRotationDegrees();
        InputImage input = InputImage.fromMediaImage(image, rotation);
        final int width = rotation % 180 == 0 ? proxy.getWidth() : proxy.getHeight();
        final int height = rotation % 180 == 0 ? proxy.getHeight() : proxy.getWidth();

        Task<List<Barcode>> barcodeTask = barcodeScanner.process(input);
        // Text recognition is the slow part; run it on every other frame so the
        // barcode boxes stay smooth.
        final boolean doOcr = ocrEnabled && (frame++ % 2 == 0);
        Task<Text> textTask = doOcr ? textRecognizer.process(input) : Tasks.forResult(null);

        Tasks.whenAllComplete(barcodeTask, textTask).addOnCompleteListener(executor, done -> {
            try {
                if (!running) return;
                JSObject event = new JSObject();
                event.put("width", width);
                event.put("height", height);
                int[] r = viewRect;
                JSObject view = new JSObject();
                view.put("x", r[0]);
                view.put("y", r[1]);
                view.put("w", r[2]);
                view.put("h", r[3]);
                event.put("view", view);

                JSArray barcodes = new JSArray();
                if (barcodeTask.isSuccessful()) {
                    for (Barcode b : barcodeTask.getResult()) {
                        if (b.getRawValue() == null || b.getCornerPoints() == null) continue;
                        JSObject o = new JSObject();
                        o.put("raw", b.getRawValue());
                        o.put("corners", corners(b.getCornerPoints()));
                        barcodes.put(o);
                    }
                }
                event.put("barcodes", barcodes);

                if (doOcr && textTask.isSuccessful() && textTask.getResult() != null) {
                    JSArray lines = new JSArray();
                    int blockIndex = 0;
                    for (Text.TextBlock block : textTask.getResult().getTextBlocks()) {
                        for (Text.Line line : block.getLines()) {
                            if (line.getCornerPoints() == null) continue;
                            JSObject o = new JSObject();
                            o.put("text", line.getText());
                            o.put("block", blockIndex);
                            o.put("corners", corners(line.getCornerPoints()));
                            lines.put(o);
                        }
                        blockIndex++;
                    }
                    event.put("lines", lines);
                }
                notifyListeners("frame", event);
            } catch (Exception ignored) {
                // drop this frame
            } finally {
                proxy.close();
            }
        });
    }

    private static JSArray corners(Point[] points) {
        JSArray arr = new JSArray();
        for (Point p : points) {
            JSArray xy = new JSArray();
            xy.put(p.x);
            xy.put(p.y);
            arr.put(xy);
        }
        return arr;
    }

    @Override
    protected void handleOnDestroy() {
        running = false;
        if (barcodeScanner != null) barcodeScanner.close();
        if (textRecognizer != null) textRecognizer.close();
        if (executor != null) executor.shutdown();
        super.handleOnDestroy();
    }
}
