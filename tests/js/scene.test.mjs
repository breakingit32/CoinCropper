// node tests/js/scene.test.mjs — scene map (remembered case layout)
import { SceneMap, apply, fit, invert, poseTo } from "../../web/scene.js";

let failed = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); if (!ok) failed++; };
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

// A case: 4 x 3 slabs, 150 x 210 apart, in case (world) coordinates.
const CASE = [];
for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++)
  CASE.push({ key: `C${r}${c}`, pose: { cx: 100 + c * 150, cy: 120 + r * 210, w: 140, h: 200, angle: 0 } });
// Camera = similarity transform case -> screen.
const cam = (s, deg, tx, ty) => { const r = deg * Math.PI / 180; return { a: s * Math.cos(r), b: s * Math.sin(r), tx, ty }; };
const onScreen = (T, keys, opts = {}) => CASE.filter((s) => keys.includes(s.key))
  .map((s) => ({ key: s.key, slab: poseTo(T, s.pose), sure: opts.sure ?? true }));

// transforms
const T = cam(1.3, 12, 40, -20);
const p = apply(invert(T), apply(T, [5, 7]));
check(near(p[0], 5, 1e-6) && near(p[1], 7, 1e-6), "invert(T) undoes T");
const F = fit(CASE.slice(0, 3).map((s) => [s.pose, poseTo(T, s.pose)]));
check(near(F.a, T.a, 1e-6) && near(F.b, T.b, 1e-6) && near(F.tx, T.tx, 1e-6), "fit recovers the camera transform");

// 1. First view: 3 slabs, all with barcodes.
const m = new SceneMap({ smooth: 1 });
let t = 0;
let r = m.update(onScreen(cam(1, 0, 0, 0), ["C00", "C01", "C10"]), t += 100);
check(m.size() === 3 && r.visible.length === 3, "first frame maps 3 slabs");

// 2. Camera pans/zooms; only C01 and C10 readable, C00 not read but remembered.
let cam2 = cam(1.2, 5, -60, 30);
r = m.update(onScreen(cam2, ["C01", "C10"]), t += 100);
const c00 = r.visible.find((v) => v.key === "C00");
const truth = poseTo(cam2, CASE[0].pose);
check(c00 && !c00.live && near(c00.slab.cx, truth.cx) && near(c00.slab.cy, truth.cy) && near(c00.slab.w, truth.w),
  `unread slab placed from memory (${c00 && [c00.slab.cx, c00.slab.cy].map(Math.round)} vs ${[truth.cx, truth.cy].map(Math.round)})`);

// 3. New slab next to known ones lands at the right case position.
r = m.update(onScreen(cam2, ["C01", "C10", "C11"]), t += 100);
const c11 = m.slabs.get("C11");
check(c11 && near(c11.world.cx, CASE[5].pose.cx, 3) && near(c11.world.cy, CASE[5].pose.cy, 3), "new slab mapped into the case frame");

// 4. Single-slab view still localises (scale + rotation from that slab).
const cam3 = cam(0.9, -8, 200, 100);
r = m.update(onScreen(cam3, ["C11"]), t += 100);
const c01 = r.visible.find((v) => v.key === "C01"), tr = poseTo(cam3, CASE[1].pose);
check(c01 && near(c01.slab.cx, tr.cx, 4) && near(c01.slab.cy, tr.cy, 4), "one recognised slab is enough to place the rest");

// 5. Text-only (unconfirmed) read needs two sightings; a misread at a known spot aliases.
const mis = { key: "C01-MISREAD", slab: poseTo(cam3, CASE[1].pose), sure: false };
r = m.update([...onScreen(cam3, ["C11"]), mis], t += 100);
check(!m.slabs.has("C01-MISREAD"), "single text read not accepted yet");
r = m.update([...onScreen(cam3, ["C11"]), mis], t += 100);
check(!m.slabs.has("C01-MISREAD") && m.resolve("C01-MISREAD") === "C01", "misread at a known slab's spot becomes that slab");
const newText = onScreen(cam3, ["C12"], { sure: false });
m.update([...onScreen(cam3, ["C11"]), ...newText], t += 100);
m.update([...onScreen(cam3, ["C11"]), ...newText], t += 100);
check(m.slabs.has("C12"), "new slab read twice from text is accepted");

// 6. Separate island, then merge when both are in view.
const m2 = new SceneMap({ smooth: 1, holdMs: 0 });
m2.update(onScreen(cam(1, 0, 0, 0), ["C00", "C01"]), 1000);
m2.update(onScreen(cam(1, 0, -900, 0), ["C03"]), 5000);           // far away, nothing known in view
check(new Set([...m2.slabs.values()].map((s) => s.island)).size === 2, "slab seen with nothing known starts a new island");
const camM = cam(0.8, 3, 10, 5);
r = m2.update(onScreen(camM, ["C01", "C03"]), 9000);
check(new Set([...m2.slabs.values()].map((s) => s.island)).size === 1, "islands merge when seen together");
const c00b = r.visible.find((v) => v.key === "C00"), t00 = poseTo(camM, CASE[0].pose);
check(c00b && near(c00b.slab.cx, t00.cx, 3) && near(c00b.slab.cy, t00.cy, 3), "merged map places every slab");

// 7. Outlier: one detection on the wrong slab doesn't drag the rest.
const m3 = new SceneMap({ smooth: 1 });
m3.update(onScreen(cam(1, 0, 0, 0), ["C00", "C01", "C02", "C10"]), 100);
const camO = cam(1.1, 2, 20, 10);
const dets = onScreen(camO, ["C00", "C01", "C02", "C10"]);
dets[3] = { ...dets[3], slab: poseTo(camO, CASE[11].pose) };          // C10 reported where C23 is
r = m3.update(dets, 200);
const v01 = r.visible.find((v) => v.key === "C01"), g01 = poseTo(camO, CASE[1].pose);
check(near(v01.slab.cx, g01.cx, 3) && near(v01.slab.cy, g01.cy, 3), "outlier match rejected");

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
