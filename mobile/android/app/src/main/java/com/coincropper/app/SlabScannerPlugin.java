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
                            bindDefault();
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

    // Preview + live analysis + photos (the normal set of camera use cases).
    private void bindDefault() {
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
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
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
        videoCapture = null;
    }

    // ---------------------------------------------------------------- video

    private androidx.camera.video.VideoCapture<androidx.camera.video.Recorder> videoCapture;
    private androidx.camera.video.Recording recording;
    private java.io.File videoFile;
    private PluginCall stopCall;
    private PluginCall startCall;

    /** Start recording a video of the case (preview keeps running; live reading pauses). */
    @PluginMethod
    public void recordStart(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (provider == null || previewView == null) {
                call.reject("Start the camera first");
                return;
            }
            if (recording != null) {
                call.reject("Already recording");
                return;
            }
            try {
                provider.unbindAll();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                androidx.camera.video.Recorder recorder = new androidx.camera.video.Recorder.Builder()
                    .setQualitySelector(androidx.camera.video.QualitySelector.fromOrderedList(
                        java.util.Arrays.asList(androidx.camera.video.Quality.UHD, androidx.camera.video.Quality.FHD, androidx.camera.video.Quality.HD),
                        androidx.camera.video.FallbackStrategy.lowerQualityOrHigherThan(androidx.camera.video.Quality.SD)))
                    .build();
                videoCapture = androidx.camera.video.VideoCapture.withOutput(recorder);
                camera = provider.bindToLifecycle((LifecycleOwner) getActivity(), CameraSelector.DEFAULT_BACK_CAMERA, preview, videoCapture);
                videoFile = new java.io.File(getContext().getCacheDir(), "sweep_" + System.currentTimeMillis() + ".mp4");
                startCall = call;
                recording = recorder
                    .prepareRecording(getContext(), new androidx.camera.video.FileOutputOptions.Builder(videoFile).build())
                    .start(ContextCompat.getMainExecutor(getContext()), this::onVideoEvent);
            } catch (Exception e) {
                recording = null;
                try { bindDefault(); } catch (Exception ignored) { }
                call.reject("Couldn't start recording: " + e.getMessage());
            }
        });
    }

    private void onVideoEvent(androidx.camera.video.VideoRecordEvent ev) {
        if (ev instanceof androidx.camera.video.VideoRecordEvent.Start) {
            if (startCall != null) {
                startCall.resolve();
                startCall = null;
            }
        } else if (ev instanceof androidx.camera.video.VideoRecordEvent.Finalize) {
            androidx.camera.video.VideoRecordEvent.Finalize f = (androidx.camera.video.VideoRecordEvent.Finalize) ev;
            recording = null;
            try { bindDefault(); } catch (Exception ignored) { }
            JSObject res = new JSObject();
            res.put("file", videoFile.getAbsolutePath());
            res.put("ms", f.getRecordingStats().getRecordedDurationNanos() / 1000000L);
            boolean bad = f.hasError() && f.getError() != androidx.camera.video.VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE;
            if (startCall != null) {
                startCall.reject("Recording failed (" + f.getError() + ")");
                startCall = null;
            }
            if (stopCall != null) {
                if (bad && !videoFile.exists()) stopCall.reject("Recording failed (" + f.getError() + ")");
                else stopCall.resolve(res);
                stopCall = null;
            }
        }
    }

    /** Stop recording; resolves { file, ms } once the video is saved. */
    @PluginMethod
    public void recordStop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recording == null) {
                call.reject("Not recording");
                return;
            }
            stopCall = call;
            recording.stop();
        });
    }

    /**
     * Pick the sharp frames of a video and read them. The video is decoded twice:
     * first every frame gets a sharpness score (variance of the Laplacian of the
     * luma, on a grid), then the sharpest frame of each window (windowMs, 400 by
     * default) is read with ML Kit, leaving out windows that are blurry next to
     * the rest (moving too fast). Progress: "videoProgress" {stage, done, total}.
     * Resolves { frames: [{ t, sharp, width, height, jpeg, barcodes, lines }] }.
     */
    @PluginMethod
    public void videoFrames(PluginCall call) {
        final String file = call.getString("file");
        final long windowUs = (long) (call.getInt("windowMs", 400)) * 1000L;
        if (file == null || barcodeScanner == null || textRecognizer == null) {
            call.reject(file == null ? "No video" : "Start the camera first");
            return;
        }
        new Thread(() -> {
            try {
                java.util.LinkedHashMap<Long, Double> score = new java.util.LinkedHashMap<>();
                decodeVideo(file, (img, t, rot) -> score.put(t, sharpness(img)), null, "score");
                if (score.isEmpty()) {
                    call.reject("The video has no frames");
                    return;
                }
                // Sharpest frame per window, then drop windows far blurrier than the typical one.
                java.util.TreeMap<Long, long[]> best = new java.util.TreeMap<>();
                java.util.HashMap<Long, Double> bestScore = new java.util.HashMap<>();
                for (java.util.Map.Entry<Long, Double> e : score.entrySet()) {
                    long w = e.getKey() / windowUs;
                    Double cur = bestScore.get(w);
                    if (cur == null || e.getValue() > cur) {
                        bestScore.put(w, e.getValue());
                        best.put(w, new long[] { e.getKey() });
                    }
                }
                double[] vals = bestScore.values().stream().mapToDouble(Double::doubleValue).sorted().toArray();
                double median = vals[vals.length / 2];
                final java.util.HashSet<Long> pick = new java.util.HashSet<>();
                for (java.util.Map.Entry<Long, long[]> e : best.entrySet()) {
                    if (bestScore.get(e.getKey()) >= 0.35 * median) pick.add(e.getValue()[0]);
                }
                final JSArray frames = new JSArray();
                final int total = pick.size();
                decodeVideo(file, (img, t, rot) -> {
                    if (!pick.contains(t)) return;
                    Bitmap bmp = rotate(yuvToBitmap(img), rot);
                    JSObject o = new JSObject();
                    o.put("t", t / 1000L);
                    o.put("sharp", Math.round(score.get(t) * 10) / 10.0);
                    o.put("width", bmp.getWidth());
                    o.put("height", bmp.getHeight());
                    o.put("jpeg", smallJpeg(bmp));
                    readSync(bmp, o);
                    frames.put(o);
                    JSObject pr = new JSObject();
                    pr.put("stage", "read");
                    pr.put("done", frames.length());
                    pr.put("total", total);
                    notifyListeners("videoProgress", pr);
                }, pick, "read");
                JSObject res = new JSObject();
                res.put("frames", frames);
                res.put("scored", score.size());
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Reading the video failed: " + e.getMessage());
            }
        }, "video-frames").start();
    }

    private interface FrameFn {
        void accept(android.media.Image img, long tUs, int rot) throws Exception;
    }

    // Decode every frame of the video's first video track into YUV images.
    private void decodeVideo(String file, FrameFn fn, java.util.Set<Long> only, String stage) throws Exception {
        android.media.MediaExtractor ex = new android.media.MediaExtractor();
        ex.setDataSource(file);
        int track = -1;
        android.media.MediaFormat fmt = null;
        for (int i = 0; i < ex.getTrackCount(); i++) {
            android.media.MediaFormat f = ex.getTrackFormat(i);
            String mime = f.getString(android.media.MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("video/")) {
                track = i;
                fmt = f;
                break;
            }
        }
        if (track < 0) {
            ex.release();
            throw new Exception("no video track");
        }
        ex.selectTrack(track);
        int rot = 0;
        if (fmt.containsKey("rotation-degrees")) rot = fmt.getInteger("rotation-degrees");
        else {
            android.media.MediaMetadataRetriever mr = new android.media.MediaMetadataRetriever();
            try {
                mr.setDataSource(file);
                String r = mr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
                if (r != null) rot = Integer.parseInt(r);
            } catch (Exception ignored) {
            } finally {
                try { mr.release(); } catch (Exception ignored) { }
            }
        }
        long durUs = fmt.containsKey(android.media.MediaFormat.KEY_DURATION) ? fmt.getLong(android.media.MediaFormat.KEY_DURATION) : 0;
        long lastT = only == null ? -1 : java.util.Collections.max(only);
        fmt.setInteger(android.media.MediaFormat.KEY_COLOR_FORMAT, android.media.MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible);
        android.media.MediaCodec codec = android.media.MediaCodec.createDecoderByType(fmt.getString(android.media.MediaFormat.KEY_MIME));
        codec.configure(fmt, null, null, 0);
        codec.start();
        android.media.MediaCodec.BufferInfo info = new android.media.MediaCodec.BufferInfo();
        boolean inDone = false, outDone = false;
        long lastNote = 0;
        try {
            while (!outDone) {
                if (!inDone) {
                    int ii = codec.dequeueInputBuffer(10000);
                    if (ii >= 0) {
                        java.nio.ByteBuffer buf = codec.getInputBuffer(ii);
                        int n = ex.readSampleData(buf, 0);
                        if (n < 0) {
                            codec.queueInputBuffer(ii, 0, 0, 0, android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            codec.queueInputBuffer(ii, 0, n, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }
                int oi = codec.dequeueOutputBuffer(info, 10000);
                if (oi >= 0) {
                    if ((info.flags & android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                    if (info.size > 0 && (only == null || only.contains(info.presentationTimeUs))) {
                        android.media.Image img = codec.getOutputImage(oi);
                        if (img != null) {
                            try { fn.accept(img, info.presentationTimeUs, rot); } finally { img.close(); }
                        }
                    }
                    codec.releaseOutputBuffer(oi, false);
                    if (only == null && durUs > 0 && System.currentTimeMillis() - lastNote > 250) {
                        lastNote = System.currentTimeMillis();
                        JSObject pr = new JSObject();
                        pr.put("stage", stage);
                        pr.put("done", info.presentationTimeUs / 1000);
                        pr.put("total", durUs / 1000);
                        notifyListeners("videoProgress", pr);
                    }
                    if (only != null && info.presentationTimeUs >= lastT) outDone = true;
                }
            }
        } finally {
            codec.stop();
            codec.release();
            ex.release();
        }
    }

    // Focus measure: variance of the 4-neighbour Laplacian of the luma, sampled every 3rd pixel.
    private static double sharpness(android.media.Image img) {
        android.graphics.Rect c = img.getCropRect();
        android.media.Image.Plane yp = img.getPlanes()[0];
        java.nio.ByteBuffer y = yp.getBuffer();
        int rs = yp.getRowStride(), ps = yp.getPixelStride();
        int x0 = c.left + 2, x1 = c.right - 2, y0 = c.top + 2, y1 = c.bottom - 2, step = Math.max(3, c.width() / 640);
        double sum = 0, sum2 = 0;
        long n = 0;
        for (int yy = y0; yy < y1; yy += step) {
            int row = yy * rs;
            for (int xx = x0; xx < x1; xx += step) {
                int i = row + xx * ps;
                int v = 4 * (y.get(i) & 255) - (y.get(i - ps) & 255) - (y.get(i + ps) & 255) - (y.get(i - rs) & 255) - (y.get(i + rs) & 255);
                sum += v;
                sum2 += (double) v * v;
                n++;
            }
        }
        if (n == 0) return 0;
        double m = sum / n;
        return sum2 / n - m * m;
    }

    // YUV_420_888 -> NV21 -> JPEG -> Bitmap (full size; done only for the picked frames).
    private static Bitmap yuvToBitmap(android.media.Image img) {
        android.graphics.Rect c = img.getCropRect();
        int w = c.width(), h = c.height();
        byte[] nv21 = new byte[w * h * 3 / 2];
        android.media.Image.Plane[] pl = img.getPlanes();
        java.nio.ByteBuffer yb = pl[0].getBuffer(), ub = pl[1].getBuffer(), vb = pl[2].getBuffer();
        int yrs = pl[0].getRowStride(), yps = pl[0].getPixelStride();
        int o = 0;
        for (int r = 0; r < h; r++) {
            int base = (r + c.top) * yrs + c.left * yps;
            if (yps == 1) {
                yb.position(base);
                yb.get(nv21, o, w);
                o += w;
            } else for (int x = 0; x < w; x++) nv21[o++] = yb.get(base + x * yps);
        }
        int urs = pl[1].getRowStride(), ups = pl[1].getPixelStride(), vrs = pl[2].getRowStride(), vps = pl[2].getPixelStride();
        for (int r = 0; r < h / 2; r++) {
            for (int x = 0; x < w / 2; x++) {
                nv21[o++] = vb.get((r + c.top / 2) * vrs + (x + c.left / 2) * vps);
                nv21[o++] = ub.get((r + c.top / 2) * urs + (x + c.left / 2) * ups);
            }
        }
        android.graphics.YuvImage yuv = new android.graphics.YuvImage(nv21, android.graphics.ImageFormat.NV21, w, h, null);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        yuv.compressToJpeg(new android.graphics.Rect(0, 0, w, h), 92, out);
        byte[] jpg = out.toByteArray();
        return android.graphics.BitmapFactory.decodeByteArray(jpg, 0, jpg.length);
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
                final int rot = image.getImageInfo().getRotationDegrees();
                try {
                    // Fast path: the camera already gives a JPEG. Save those bytes as they
                    // are (no decode or re-encode); the rotation goes in the file name and
                    // is applied when the photo is read.
                    if (!read && image.getFormat() == android.graphics.ImageFormat.JPEG) {
                        java.nio.ByteBuffer buf = image.getPlanes()[0].getBuffer();
                        byte[] bytes = new byte[buf.remaining()];
                        buf.get(bytes);
                        int w = image.getWidth(), h = image.getHeight();
                        image.close();
                        java.io.File f = new java.io.File(getContext().getCacheDir(), "case_" + System.currentTimeMillis() + "_r" + rot + ".jpg");
                        try (java.io.FileOutputStream out = new java.io.FileOutputStream(f)) {
                            out.write(bytes);
                        }
                        android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
                        o.inSampleSize = Math.max(1, Math.max(w, h) / 1200);
                        Bitmap small = rotate(android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o), rot);
                        JSObject res = new JSObject();
                        res.put("file", f.getAbsolutePath());
                        res.put("width", rot % 180 == 0 ? w : h);
                        res.put("height", rot % 180 == 0 ? h : w);
                        res.put("jpeg", smallJpeg(small));
                        call.resolve(res);
                        return;
                    }
                    Bitmap photo = rotate(image.toBitmap(), rot);
                    image.close();
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
                    try { image.close(); } catch (Exception ignored) { }
                    call.reject("Photo failed: " + e.getMessage());
                }
            }

            @Override
            public void onError(@NonNull ImageCaptureException e) {
                call.reject("Photo failed: " + e.getMessage());
            }
        });
    }

    /**
     * Focus at a point of the preview ({x, y} as 0..1 of the view; default the
     * centre). lock=true (default) keeps focus and exposure there until unlocked
     * or focus is called again; lock=false lets the camera return to autofocus.
     * Resolves { focused } once the lens has settled.
     */
    @PluginMethod
    public void focus(PluginCall call) {
        final boolean lock = call.getBoolean("lock", true);
        final float x = call.getFloat("x", 0.5f), y = call.getFloat("y", 0.5f);
        getActivity().runOnUiThread(() -> {
            if (camera == null || previewView == null) {
                call.reject("Camera not started");
                return;
            }
            if (!lock) {
                camera.getCameraControl().cancelFocusAndMetering();
                JSObject res = new JSObject();
                res.put("focused", false);
                res.put("locked", false);
                call.resolve(res);
                return;
            }
            androidx.camera.core.MeteringPoint pt = previewView.getMeteringPointFactory()
                .createPoint(x * previewView.getWidth(), y * previewView.getHeight());
            androidx.camera.core.FocusMeteringAction action = new androidx.camera.core.FocusMeteringAction.Builder(pt,
                    androidx.camera.core.FocusMeteringAction.FLAG_AF | androidx.camera.core.FocusMeteringAction.FLAG_AE)
                .disableAutoCancel()
                .build();
            ListenableFuture<androidx.camera.core.FocusMeteringResult> f = camera.getCameraControl().startFocusAndMetering(action);
            f.addListener(() -> {
                JSObject res = new JSObject();
                try {
                    res.put("focused", f.get().isFocusSuccessful());
                } catch (Exception e) {
                    res.put("focused", false);
                }
                res.put("locked", true);
                call.resolve(res);
            }, ContextCompat.getMainExecutor(getContext()));
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
                    java.util.regex.Matcher m = java.util.regex.Pattern.compile("_r(\\d+)\\.jpg$").matcher(file);
                    if (m.find()) rot = Integer.parseInt(m.group(1));
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
                fillResults(bt, tt, res);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Reading the photo failed: " + e.getMessage());
            }
        });
    }

    // Same, blocking (call off the main thread).
    private void readSync(Bitmap photo, JSObject res) throws Exception {
        InputImage input = InputImage.fromBitmap(photo, 0);
        Task<List<Barcode>> bt = barcodeScanner.process(input);
        Task<Text> tt = textRecognizer.process(input);
        Tasks.await(Tasks.whenAllComplete(bt, tt));
        fillResults(bt, tt, res);
    }

    private void fillResults(Task<List<Barcode>> bt, Task<Text> tt, JSObject res) {
        {
            {
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
            }
        }
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
