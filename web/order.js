// Case order check: is every slab where it belongs?
//
// Correct order: denomination (series order) > date > mint mark > business
// before proof > plain before varieties > grade (low to high by default) >
// designation (DMPL, PL, plain; UCAM/DCAM, CAM, plain; RD, RB, BN; FB/FS/FH
// first) > CAC (Gold, Green, none).
//
// The case is read like a page: rows top to bottom, left to right within a row.
// Slabs to move are the fewest that put the rest in order (the others form the
// longest correctly ordered run).

import { normaliseGrade } from "./core.js";
import { wantedFromLabel } from "./catalog.js";

const DENOM_ORDER = [
  [/^(1\/2C|HALF ?C(ENT)?)$/i, 0], [/^1C$/i, 1], [/^2C$/i, 2], [/^3CS$/i, 3], [/^3CN?$/i, 4],
  [/^H10C$/i, 5], [/^5C$/i, 6], [/^10C$/i, 7], [/^20C$/i, 8], [/^25C$/i, 9], [/^50C$/i, 10],
  [/^(S\$1|\$1|T\$1)$/i, 11], [/^G\$1$/i, 12], [/^\$2(\.50)?$/i, 13], [/^\$3$/i, 14], [/^\$5$/i, 15],
  [/^\$10$/i, 16], [/^\$20$/i, 17],
];
const MINT_ORDER = ["", "P", "C", "CC", "D", "O", "S", "W"];

export function denomRank(d) {
  const hit = DENOM_ORDER.find(([re]) => re.test(String(d || "").replace(/\s/g, "")));
  return hit ? hit[1] : 99;
}

// Everything the order needs, from what the app knows about a coin.
export function orderFields(coin) {
  const c = coin?.result?.coin || {};
  const ocr = coin?.overrides?.ocr_text || "";
  // Label line with the date, e.g. "1909 S VDB 1C" / "1900-O/CC S$1" / PCGS name "1903-O $1".
  const lines = [c.description, ...ocr.split(/\n/)].filter(Boolean);
  let w = null;
  for (const l of lines) { w = wantedFromLabel({ description: l, year: c.year, mint_mark: c.mint_mark, grade: c.grade }); if (w?.denom) break; }
  if (!w) return null;
  const [grade, num] = normaliseGrade(c.grade || ocr);
  const g = String(grade || "").toUpperCase();
  const plus = /\+/.test(g);
  const desig = /\b(DMPL|DPL)\b/.test(g) ? 0 : /\bPL\b/.test(g) ? 1
    : /\b(UCAM|DCAM)\b/.test(g) ? 0 : /\bCAM\b/.test(g) ? 1
    : /\bRD\b/.test(g) ? 0 : /\bRB\b/.test(g) ? 1 : /\bBN\b/.test(g) ? 2
    : /\b(FB|FBL|FS|FH|FT)\b/.test(g) ? 0 : 2;
  const cac = coin?.result?.grading?.cac;
  return {
    denom: w.denom, denomRank: denomRank(w.denom), year: +w.year, mint: w.mint || "",
    proof: !!w.proof || /^(PR|PF)/.test(g), variety: w.variety || "", grade: grade || null,
    gradeNum: num ? num + (plus ? 0.5 : 0) : null, desig, cac: cac === "Gold" ? 0 : cac === "Green" ? 1 : 2,
    label: [lines[0], grade].filter(Boolean).join(" · "),
  };
}

// Negative when a belongs before b.
export function compareCoins(a, b, { gradeDescending = false } = {}) {
  const mintRank = (m) => { const i = MINT_ORDER.indexOf(m); return i < 0 ? 50 : i; };
  return (a.denomRank - b.denomRank)
    || (a.year - b.year)
    || (mintRank(a.mint) - mintRank(b.mint))
    || ((a.proof ? 1 : 0) - (b.proof ? 1 : 0))
    || ((a.variety ? 1 : 0) - (b.variety ? 1 : 0)) || a.variety.localeCompare(b.variety)
    || (gradeDescending ? (b.gradeNum ?? 0) - (a.gradeNum ?? 0) : (a.gradeNum ?? 0) - (b.gradeNum ?? 0))
    || (a.desig - b.desig)
    || (a.cac - b.cac);
}

// Slabs [{key, x, y, w, h}] (case positions) -> keys in reading order.
export function readingOrder(slabs) {
  if (!slabs.length) return [];
  const hs = slabs.map((s) => s.h).sort((p, q) => p - q);
  const rowGap = 0.5 * hs[Math.floor(hs.length / 2)];
  const byY = [...slabs].sort((p, q) => p.y - q.y);
  const rows = [];
  for (const s of byY) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(s.y - row.y) < rowGap) { row.items.push(s); row.y = row.items.reduce((t, i) => t + i.y, 0) / row.items.length; }
    else rows.push({ y: s.y, items: [s] });
  }
  return rows.flatMap((r, ri) => r.items.sort((p, q) => p.x - q.x).map((s, ci) => ({ key: s.key, row: ri, col: ci })));
}

// Longest run already in order (non-decreasing); everything else must move.
function keepSet(seq, cmp) {
  const n = seq.length, len = Array(n).fill(1), prev = Array(n).fill(-1);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < i; j++)
      if (cmp(seq[j].f, seq[i].f) <= 0 && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
  let end = 0;
  for (let i = 1; i < n; i++) if (len[i] > len[end]) end = i;
  const keep = new Set();
  for (let i = end; i >= 0; i = prev[i]) keep.add(seq[i].key);
  return keep;
}

/**
 * slabs: [{key, x, y, w, h}], fieldsOf(key) -> orderFields or null.
 * Returns {items: Map(key -> {pos, row, col, ok, known, after, before}), wrong, unknown}.
 * after/before: label of the slab this one should follow / precede.
 */
export function checkOrder(slabs, fieldsOf, opts = {}) {
  const cmp = (a, b) => compareCoins(a, b, opts);
  const seq = readingOrder(slabs).map((p, i) => ({ ...p, pos: i + 1, f: fieldsOf(p.key) }));
  const known = seq.filter((s) => s.f && s.f.denomRank < 99 && s.f.year && s.f.gradeNum != null);
  const keep = keepSet(known, cmp);
  const sorted = [...known].sort((a, b) => cmp(a.f, b.f));
  const items = new Map();
  for (const s of seq) {
    const isKnown = known.includes(s);
    const ok = isKnown ? keep.has(s.key) : null;
    let after = null, before = null;
    if (isKnown && !ok) {
      const i = sorted.indexOf(s);
      after = sorted.slice(0, i).reverse().find((o) => o !== s)?.f.label || null;
      before = sorted.slice(i + 1).find((o) => o !== s)?.f.label || null;
    }
    items.set(s.key, { pos: s.pos, row: s.row, col: s.col, known: isKnown, ok, after, before, label: s.f?.label || null });
  }
  return { items, wrong: known.length - keep.size, unknown: seq.length - known.length, total: seq.length };
}
