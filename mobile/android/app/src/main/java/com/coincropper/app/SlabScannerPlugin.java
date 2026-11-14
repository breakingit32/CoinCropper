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
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import android.graphics.Bitmap;
import android.graphics.Matrix;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
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
    private ImageCapture imageCapture;
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
                            imageCapture = new ImageCapture.Builder()
                                .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                                .build();
                            try {
                                camera = provider.bindToLifecycle(
                                    (LifecycleOwner) getActivity(),
                                    CameraSelector.DEFAULT_BACK_CAMERA,
                                    preview,
                                    analysis,
                                    imageCapture
                                );
                            } catch (Exception e) {
                                // Some phones can't run all three at once: live scanning still works.
                                imageCapture = null;
                                provider.unbindAll();
                                camera = provider.bindToLifecycle(
                                    (LifecycleOwner) getActivity(),
                                    CameraSelector.DEFAULT_BACK_CAMERA,
                                    preview,
                                    analysis
                                );
                            }
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

    /**
     * Take a full-resolution photo and turn it upright. With read=false (default
     * true) it is only saved, for reading later with read({file}); returns
     * { file, width, height, jpeg } (jpeg = a smaller copy for display).
     * With read=true it is also read: + { barcodes, lines } in photo pixels.
     */
    @PluginMethod
    public void capture(PluginCall call) {
        if (imageCapture == null) {
            call.reject("Photos aren't available on this phone");
            return;
        }
        final boolean read = call.getBoolean("read", true);
        imageCapture.takePicture(executor, new ImageCapture.OnImageCapturedCallback() {
            @Override
            public void onCaptureSuccess(@NonNull ImageProxy image) {
                Bitmap photo;
                try {
                    photo = rotate(image.toBitmap(), image.getImageInfo().getRotationDegrees());
                } catch (Exception e) {
                    image.close();
                    call.reject("Photo failed: " + e.getMessage());
                    return;
                }
                image.close();
                try {
                    java.io.File f = new java.io.File(getContext().getCacheDir(), "case_" + System.currentTimeMillis() + ".jpg");
                    try (java.io.FileOutputStream out = new java.io.FileOutputStream(f)) {
                        photo.compress(Bitmap.CompressFormat.JPEG, 92, out);
                    }
                    JSObject res = new JSObject();
                    res.put("file", f.getAbsolutePath());
                    res.put("width", photo.getWidth());
                    res.put("height", photo.getHeight());
                    res.put("jpeg", smallJpeg(photo));
                    if (read) readBitmap(photo, call, res);
                    else call.resolve(res);
                } catch (Exception e) {
                    call.reject("Saving the photo failed: " + e.getMessage());
                }
            }

            @Override
            public void onError(@NonNull ImageCaptureException e) {
                call.reject("Photo failed: " + e.getMessage());
            }
        });
    }

    /**
     * Read a saved photo ({file}) or a picture from the gallery ({data}: data URL
     * or base64). Returns { width, height, barcodes, lines } (+ jpeg for {data}).
     */
    @PluginMethod
    public void read(PluginCall call) {
        if (barcodeScanner == null || textRecognizer == null) {
            call.reject("Start the camera first");
            return;
        }
        String file = call.getString("file");
        String data = call.getString("data");
        executor.execute(() -> {
            try {
                Bitmap bmp;
                int rot = 0;
                if (file != null) {
                    bmp = android.graphics.BitmapFactory.decodeFile(file);
                } else if (data != null) {
                    byte[] bytes = Base64.decode(data.replaceFirst("^data:[^,]*,", ""), Base64.DEFAULT);
                    bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                    try {
                        android.media.ExifInterface exif = new android.media.ExifInterface(new java.io.ByteArrayInputStream(bytes));
                        int o = exif.getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL);
                        rot = o == android.media.ExifInterface.ORIENTATION_ROTATE_90 ? 90
                            : o == android.media.ExifInterface.ORIENTATION_ROTATE_180 ? 180
                            : o == android.media.ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
                    } catch (Exception ignored) {
                        rot = 0;
                    }
                } else {
                    call.reject("Nothing to read");
                    return;
                }
                if (bmp == null) {
                    call.reject("Couldn't open that picture");
                    return;
                }
                // Very large gallery pictures: keep reading fast and memory safe.
                float k = Math.min(1f, 4000f / Math.max(bmp.getWidth(), bmp.getHeight()));
                if (k < 1f) bmp = Bitmap.createScaledBitmap(bmp, Math.round(bmp.getWidth() * k), Math.round(bmp.getHeight() * k), true);
                Bitmap photo = rotate(bmp, rot);
                JSObject res = new JSObject();
                res.put("width", photo.getWidth());
                res.put("height", photo.getHeight());
                if (data != null) res.put("jpeg", smallJpeg(photo));
                readBitmap(photo, call, res);
            } catch (Exception e) {
                call.reject("Reading the picture failed: " + e.getMessage());
            }
        });
    }

    private static Bitmap rotate(Bitmap raw, int rot) {
        if (rot == 0) return raw;
        Matrix m = new Matrix();
        m.postRotate(rot);
        return Bitmap.createBitmap(raw, 0, 0, raw.getWidth(), raw.getHeight(), m, true);
    }

    private static String smallJpeg(Bitmap photo) {
        float k = Math.min(1f, 1600f / Math.max(photo.getWidth(), photo.getHeight()));
        Bitmap small = k < 1f ? Bitmap.createScaledBitmap(photo, Math.round(photo.getWidth() * k), Math.round(photo.getHeight() * k), true) : photo;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        small.compress(Bitmap.CompressFormat.JPEG, 78, out);
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    // ML Kit barcodes + text on an upright bitmap; adds them to res and resolves the call.
    private void readBitmap(Bitmap photo, PluginCall call, JSObject res) {
        InputImage input = InputImage.fromBitmap(photo, 0);
        Task<List<Barcode>> bt = barcodeScanner.process(input);
        Task<Text> tt = textRecognizer.process(input);
        Tasks.whenAllComplete(bt, tt).addOnCompleteListener(executor, done -> {
            try {
                JSArray barcodes = new JSArray();
                if (bt.isSuccessful()) for (Barcode b : bt.getResult()) {
                    if (b.getRawValue() == null || b.getCornerPoints() == null) continue;
                    JSObject o = new JSObject();
                    o.put("raw", b.getRawValue());
                    o.put("corners", corners(b.getCornerPoints()));
                    barcodes.put(o);
                }
                res.put("barcodes", barcodes);
                JSArray lines = new JSArray();
                if (tt.isSuccessful() && tt.getResult() != null) {
                    int bi = 0;
                    for (Text.TextBlock block : tt.getResult().getTextBlocks()) {
                        for (Text.Line line : block.getLines()) {
                            if (line.getCornerPoints() == null) continue;
                            JSObject o = new JSObject();
                            o.put("text", line.getText());
                            o.put("block", bi);
                            o.put("corners", corners(line.getCornerPoints()));
                            lines.put(o);
                        }
                        bi++;
                    }
                }
                res.put("lines", lines);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Reading the photo failed: " + e.getMessage());
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
                // Raw analysis buffer and its rotation, so the page can put points
                // upright itself if ML Kit reported them in buffer orientation.
                event.put("rotation", rotation);
                event.put("bufferWidth", proxy.getWidth());
                event.put("bufferHeight", proxy.getHeight());
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
