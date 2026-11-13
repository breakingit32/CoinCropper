// Slab label model: turns one camera frame's text lines and barcodes into slabs,
// each with its rectangle on screen (the area of interest) and its label fields.
//
// Labels follow one layout:
//
//   ┌─────────────────────────────────────────┐
//   │ 1900-O/CC                          S$1  │  year (top left), denomination (top right)
//   │                 MS64                    │  grade (middle)
//   │          7268.64/2401136                │  PCGS# . grade / cert   ← anchor
//   │        ║║│║║│║│║║│║║║│║║│║             │  barcode
//   └─────────────────────────────────────────┘
//   │                  ( coin )               │  rest of the slab
//
// Everything is measured in the anchor line's own frame (along the line = u,
// down the label = v, in units of its height), so slanted or rotated slabs work.

import { fixOcrDenom, labelAnchor, normaliseGrade } from "./core.js";

// Slab proportions relative to the label (typical PCGS/NGC holders; tune here).
export const LAYOUT = {
  slabWidthPerLabel: 1.38,   // slab width / width of the label text (calibrated on PCGS holders)
  slabHeightPerWidth: 1.42,  // slab height / slab width
  slabTopAboveLabel: 0.10,   // gap from slab top to label top, × label width
  minLabelPerAnchor: 1.35,   // label is at least this × the cert line's width
  labelPerBarcode: 1.5,      // label width / barcode width (barcode-only slabs)
  labelHeightPerWidth: 0.4,  // label height / label width (barcode-only slabs)
};

const YEAR_RE = /\b(1[6-9]\d{2}|20\d{2})\b/;
const DENOM_RE = /(\b[SG]?\$\s?\d+(?:\.\d+)?\b|\$\s?\d+|\b\d+\s?C\b|\bH10C\b|\b\d+\s?CENTS?\b|\bDOLLAR\b|\bEAGLE\b)/i;

// ------------------------------------------------------------ geometry

const centroid = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

// Local frame of a detected box (corners clockwise from top-left).
// Doesn't rely on the corner order (it changes with image rotation): the
// longer side is the reading direction, taken to run left-to-right on screen,
// and v points down the label.
export function frameOf(corners) {
  const [p0, p1, p2] = corners;
  const e1 = [p1[0] - p0[0], p1[1] - p0[1]], e2 = [p2[0] - p1[0], p2[1] - p1[1]];
  const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
  let [ux, uy] = l1 >= l2 ? e1 : e2;
  const w = Math.max(l1, l2) || 1, h = Math.min(l1, l2) || 1;
  ux /= w; uy /= w;
  if (ux < 0 || (Math.abs(ux) < 1e-6 && uy < 0)) { ux = -ux; uy = -uy; }
  const vx = -uy, vy = ux;   // 90° clockwise from u: "down" when u points right
  return { c: centroid(corners), u: [ux, uy], v: [vx, vy], w, h };
}
const proj = (f, p) => [(p[0] - f.c[0]) * f.u[0] + (p[1] - f.c[1]) * f.u[1],
                        (p[0] - f.c[0]) * f.v[0] + (p[1] - f.c[1]) * f.v[1]];
const unproj = (f, a, b) => [f.c[0] + a * f.u[0] + b * f.v[0], f.c[1] + a * f.u[1] + b * f.v[1]];
function extent(f, corners) {
  const ps = corners.map((p) => proj(f, p));
  const us = ps.map((p) => p[0]), vs = ps.map((p) => p[1]);
  return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
}
const angleOf = (f) => Math.atan2(f.u[1], f.u[0]);

// Slab rectangle {cx, cy, w, h, angle} from a label rectangle in frame f.
function slabFromLabel(f, L) {
  const lw = L.u1 - L.u0;
  const w = lw * LAYOUT.slabWidthPerLabel, h = w * LAYOUT.slabHeightPerWidth;
  const top = L.v0 - lw * LAYOUT.slabTopAboveLabel;
  const [cx, cy] = unproj(f, (L.u0 + L.u1) / 2, top + h / 2);
  return { cx, cy, w, h, angle: angleOf(f) };
}

// Slab geometry relative to a barcode, so frames where only the barcode is
// read keep the same rectangle that the label text produced.
function relativeTo(fb, slab) {
  const [a, b] = proj(fb, [slab.cx, slab.cy]);
  return { a: a / fb.w, b: b / fb.w, w: slab.w / fb.w, h: slab.h / fb.w, da: slab.angle - angleOf(fb) };
}
export function slabFromBarcode(corners, rel) {
  const fb = frameOf(corners);
  if (rel) {
    const [cx, cy] = unproj(fb, rel.a * fb.w, rel.b * fb.w);
    return { cx, cy, w: rel.w * fb.w, h: rel.h * fb.w, angle: angleOf(fb) + rel.da };
  }
  const lw = fb.w * LAYOUT.labelPerBarcode, bottom = fb.h * 0.7;
  return slabFromLabel(fb, { u0: -lw / 2, u1: lw / 2, v0: bottom - lw * LAYOUT.labelHeightPerWidth, v1: bottom });
}

// ------------------------------------------------------------ label fields

// OCR often reads the mint mark "O" as zero: 1900-0/CC -> 1900-O/CC
const fixYear = (t) => t.replace(/(\d{4})\s?-\s?0\b/, "$1-O").replace(/\/0\b/, "/O");

const SERVICE_RE = /^\s*(PCGS|NGC|CACG|ANACS|ICG)\b/i;

function readFields(members, anchorText, H) {
  const f = { year: null, denomination: null, grade: null };
  // Top row = the row holding the year (a "PCGS" header may sit above it).
  const yearLine = members.filter((m) => YEAR_RE.test(m.text)).sort((p, q) => p.cv - q.cv)[0];
  const rowV = yearLine ? yearLine.cv
    : Math.min(...members.filter((m) => !SERVICE_RE.test(m.text)).map((m) => m.cv));
  const top = members.filter((m) => Math.abs(m.cv - rowV) < 0.8 * H);
  if (yearLine) {
    f.year = fixOcrDenom(fixYear(yearLine.text.trim()));
    // NGC-style "1916 D 10C": denomination on the same line as the year.
    const d = DENOM_RE.exec(f.year.slice(f.year.search(YEAR_RE) + 4));
    if (d) { f.denomination = d[0].trim(); f.year = f.year.replace(d[0], "").trim(); }
  }
  if (!f.denomination) {
    const right = top.filter((m) => m !== yearLine && !SERVICE_RE.test(m.text) && !normaliseGrade(m.text)[0])
      .sort((p, q) => q.cu - p.cu)[0];
    if (right) f.denomination = right.text.trim();
  }
  // Grade: the line between the top row and the cert line (closest to the cert line first).
  const g = [...members].sort((p, q) => q.cv - p.cv).map((m) => normaliseGrade(m.text)[0]).find(Boolean) ||
    normaliseGrade(anchorText)[0];
  f.grade = g || null;   // if unread, parseLabelText derives it from the cert line's number
  return f;
}

// Canonical label text for parseLabelText(): "year denom / service grade / cert line".
function canonicalText(id, fields, anchorText) {
  const line1 = [fields.year, fields.denomination].filter(Boolean).join(" ");
  const line2 = [id.service, fields.grade].filter(Boolean).join(" ");
  return [line1, line2, anchorText.trim()].filter(Boolean).join("\n");
}

// ------------------------------------------------------------ per frame

/**
 * lines:    [{text, corners}]  screen coords
 * barcodes: [{raw, corners}]   screen coords
 * Returns slabs [{cert, code, slab, fields, ocr, rel}] and the barcodes that
 * were not part of any recognised label.
 */
export function readSlabs(lines, barcodes) {
  const slabs = [];
  const usedBars = new Set();
  // Each text line / barcode belongs to the nearest cert line it could be part
  // of, so closely packed slabs don't share label lines.
  // Upside-down labels (far side of a case): the label's other lines sit
  // above the cert line and the barcode below it; pick the way up that finds more.
  const flip = (f) => ({ ...f, u: [-f.u[0], -f.u[1]], v: [-f.v[0], -f.v[1]] });
  const fit = (f, self) => {
    let n = 0;
    for (const l of lines) {
      if (l === self || labelAnchor(l.text)) continue;
      const [cu, cv] = proj(f, centroid(l.corners));
      if (cv < -0.5 * f.h && cv > -9 * f.h && Math.abs(cu) < 1.5 * f.w) n++;
    }
    for (const b of barcodes) {
      const [cu, cv] = proj(f, centroid(b.corners));
      if (cv > 0.3 * f.h && cv < 5 * f.h && Math.abs(cu) < 1.2 * f.w) n++;
    }
    return n;
  };
  const anchors = lines.filter((l) => labelAnchor(l.text)).map((l) => {
    const f = frameOf(l.corners), g = flip(f);
    return { l, f: fit(g, l) > fit(f, l) ? g : f };
  });
  const owner = new Map();
  const claim = (item, inWindow) => {
    let best = null, bestCost = Infinity;
    for (const a of anchors) {
      const [cu, cv] = proj(a.f, centroid(item.corners));
      if (!inWindow(cu, cv, a.f)) continue;
      const cost = (cu / a.f.w) ** 2 + ((cv + (cv < 0 ? 3 : -1.5) * a.f.h) / (6 * a.f.h)) ** 2;
      if (cost < bestCost) { bestCost = cost; best = a.l; }
    }
    owner.set(item, best);
  };
  for (const l of lines) if (!labelAnchor(l.text)) claim(l, (cu, cv, f) => cv < -0.5 * f.h && cv > -9 * f.h && Math.abs(cu) < 1.5 * f.w);
  for (const b of barcodes) claim(b, (cu, cv, f) => cv > 0.3 * f.h && cv < 5 * f.h && Math.abs(cu) < 1.2 * f.w);
  for (const { l: anchor, f } of anchors) {
    const id = labelAnchor(anchor.text);
    const H = f.h, W = f.w;

    // Lines above the anchor on the same label: walk upward while rows are
    // close together, so the next slab's label above is not pulled in.
    const cands = lines.filter((l) => owner.get(l) === anchor).map((l) => {
      const [cu, cv] = proj(f, centroid(l.corners));
      return { text: l.text, corners: l.corners, cu, cv };
    }).filter((m) => m.cv < -0.5 * H && m.cv > -9 * H && Math.abs(m.cu) < 1.5 * W)
      .sort((p, q) => q.cv - p.cv);
    const members = [];
    let prev = 0;
    for (const m of cands) {
      // Real PCGS labels: grade line ~4 line-heights above the cert line.
      if (prev - m.cv > 5 * H) break;
      members.push(m); prev = m.cv;
    }

    // Barcode just below the anchor line.
    let bar = null;
    for (const b of barcodes) {
      if (usedBars.has(b) || owner.get(b) !== anchor) continue;
      const [bu, bv] = proj(f, centroid(b.corners));
      if (bv > 0.3 * H && bv < 5 * H && Math.abs(bu) < 1.2 * W) { bar = b; break; }
    }
    if (bar) usedBars.add(bar);

    // Label rectangle: union of everything on it, padded, at least a minimum width.
    const parts = [anchor.corners, ...members.map((m) => m.corners), ...(bar ? [bar.corners] : [])];
    const L = parts.map((c) => extent(f, c)).reduce((a, e) => ({
      u0: Math.min(a.u0, e.u0), u1: Math.max(a.u1, e.u1), v0: Math.min(a.v0, e.v0), v1: Math.max(a.v1, e.v1) }));
    L.u0 -= 0.5 * H; L.u1 += 0.5 * H; L.v0 -= 0.5 * H; L.v1 += 0.5 * H;
    const minW = W * LAYOUT.minLabelPerAnchor;
    if (L.u1 - L.u0 < minW) { const mid = (L.u0 + L.u1) / 2; L.u0 = mid - minW / 2; L.u1 = mid + minW / 2; }
    if (!members.length) L.v0 = Math.min(L.v0, -4.5 * H);   // year/grade rows not read yet

    const slab = slabFromLabel(f, L);
    const fields = members.length ? readFields(members, anchor.text, H) : { year: null, denomination: null, grade: null };
    slabs.push({
      cert: id.cert, service: id.service, code: bar?.raw || null, slab, fields,
      ocr: canonicalText(id, fields, anchor.text),
      complete: !!(fields.year && (fields.grade || id.grade_num)),
      rel: bar ? relativeTo(frameOf(bar.corners), slab) : null,
    });
  }
  return { slabs, loose: barcodes.filter((b) => !usedBars.has(b)) };
}
