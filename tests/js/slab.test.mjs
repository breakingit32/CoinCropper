// node tests/js/slab.test.mjs — label model on real labels (positions read off a
// phone screenshot of a PCGS case; screen px). Locks the slab-size calibration.
import { readSlabs } from "../../web/slab.js";

let failed = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); if (!ok) failed++; };
const R = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const CASES = [
  { name: "1807 50C AU53 (modern PCGS)", real: [160, 1085, 470, 1530], fields: { year: "1807", denomination: "50C", grade: "AU53" },
    lines: [["1807", 210, 1118, 245, 1132], ["50C", 400, 1118, 430, 1132], ["PCGS AU53", 288, 1137, 390, 1152],
            ["Draped Bust", 305, 1158, 385, 1170], ["6079.53/54253891", 270, 1192, 400, 1206]] },
  { name: "1921 25C MS63 (modern PCGS)", real: [175, 268, 480, 650], fields: { year: "1921", denomination: "25C", grade: "MS63" },
    lines: [["1921", 235, 300, 270, 315], ["25C", 395, 300, 425, 315], ["PCGS MS63", 305, 318, 395, 333],
            ["5740.63/53977760", 285, 365, 410, 377]] },
  { name: "1795 50C VG8 (old green holder)", real: [495, 655, 800, 1060], fields: { denomination: "50C", grade: "VG8" },
    lines: [["PCGS", 620, 692, 670, 702], ["VG08", 620, 722, 670, 738], ["50C", 715, 705, 750, 720],
            ["6052.08/7454263", 595, 757, 705, 770]] },
];

for (const c of CASES) {
  const r = readSlabs(c.lines.map(([text, ...b]) => ({ text, corners: R(...b) })), []);
  const s = r.slabs[0];
  for (const [k, v] of Object.entries(c.fields)) check(s.fields[k] === v, `${c.name}: ${k} = ${s.fields[k]}`);
  const [x0, y0, x1, y1] = c.real, rw = x1 - x0, rh = y1 - y0;
  const ox0 = s.slab.cx - s.slab.w / 2, ox1 = s.slab.cx + s.slab.w / 2, oy0 = s.slab.cy - s.slab.h / 2;
  // centre within 10% of the slab width, width within 25%, top within 8% of height
  check(Math.abs((ox0 + ox1) / 2 - (x0 + x1) / 2) < 0.1 * rw, `${c.name}: centred (${Math.round((ox0 + ox1) / 2)} vs ${(x0 + x1) / 2})`);
  check(Math.abs(s.slab.w - rw) < 0.25 * rw, `${c.name}: width ${Math.round(s.slab.w)} vs ${rw}`);
  check(Math.abs(oy0 - y0) < 0.08 * rh, `${c.name}: top ${Math.round(oy0)} vs ${y0}`);
}
// Two NGC labels side by side, close together: each keeps its own lines.
{
  const L = (x, d, g, c) => [{ text: d, corners: R(x, 400, x + 80, 420) }, { text: g, corners: R(x, 430, x + 50, 450) },
                             { text: c, corners: R(x, 465, x + 100, 482) }];
  const r = readSlabs([...L(30, "1921 10C", "AU 55", "2047300-004"), ...L(150, "1916 D 10C", "F 15", "1275103-001")], []);
  const a = r.slabs.find((x) => x.cert === "2047300-004"), b = r.slabs.find((x) => x.cert === "1275103-001");
  check(a.fields.grade === "AU55" && /1921/.test(a.fields.year) && b.fields.grade === "F15" && /1916/.test(b.fields.year),
    `packed neighbours keep their own lines (${a.fields.year} ${a.fields.grade} / ${b.fields.year} ${b.fields.grade})`);
}

// Upside-down label (far side of the case): rotate the 1807 label 180° about a point.
{
  const c = CASES[0], P = [500, 1000];
  const rot = (pts) => pts.map(([x, y]) => [2 * P[0] - x, 2 * P[1] - y]);
  const r = readSlabs(c.lines.map(([text, ...b]) => ({ text, corners: rot(R(...b)) })), []);
  const s = r.slabs[0];
  const [x0, y0, x1, y1] = c.real, cy = 2 * P[1] - (y0 + y1) / 2;   // real slab centre, rotated
  check(s.fields.year === "1807" && s.fields.grade === "AU53" && Math.abs(s.slab.cy - cy) < 0.15 * (y1 - y0) && Math.abs(Math.abs(s.slab.angle) - Math.PI) < 0.05,
    `upside-down label: fields read, slab on the coin side (cy ${Math.round(s.slab.cy)} vs ${Math.round(cy)})`);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
