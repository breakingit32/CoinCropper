// Label text -> PCGS number, offline, from web/pcgs-index.json (PCGS # ->
// {name, y: year, d: denomination, m: mint, g: designation, v: variety, s: series},
// built with scripts/build_pcgs_index.py). Works for NGC (and any) slabs whose
// label can be read, with no network.

import { wantedFromLabel } from "./catalog.js";
import { denomRank } from "./order.js";

let indexPromise = null;
export function loadPcgsIndex(fetchImpl = globalThis.fetch) {
  if (!indexPromise) indexPromise = fetchImpl("pcgs-index.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return indexPromise;
}

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const isProof = (e) => /\b(PR|PF|PROOF)\b/.test(norm(e.name)) || /PROOF/.test(norm(e.s));
const DESIG_OF = (e) => {
  const t = norm(`${e.g || ""} ${e.name || ""}`);
  for (const [re, d] of [[/\bDMPL\b/, "DMPL"], [/\bPL\b/, "PL"], [/\bDCAM\b|\bDEEP CAMEO\b/, "DCAM"], [/\bCAM\b|\bCAMEO\b/, "CAM"],
    [/\bRD\b/, "RD"], [/\bRB\b/, "RB"], [/\bBN\b/, "BN"], [/\bFBL\b/, "FBL"], [/\bFB\b/, "FB"], [/\bFS\b/, "FS"], [/\bFH\b/, "FH"], [/\bFT\b/, "FT"]])
    if (re.test(t)) return d;
  return null;
};

// Group the index by (denomination rank, year) once.
const buckets = new WeakMap();
function bucketsOf(index) {
  let b = buckets.get(index);
  if (!b) {
    b = new Map();
    for (const [pcgs, e] of Object.entries(index)) {
      if (pcgs.startsWith("_") || !e?.y) continue;
      const k = `${denomRank(e.d)}|${e.y}`;
      (b.get(k) || b.set(k, []).get(k)).push({ pcgs, ...e });
    }
    buckets.set(index, b);
  }
  return b;
}

export function scoreEntry(w, e) {
  const mint = norm(e.m) === "P" ? "" : norm(e.m);
  if ((w.mint || "") !== mint) return -1;
  if (isProof(e) !== !!w.proof) return -1;
  let score = 10;
  const d = DESIG_OF(e);
  if (w.desig) score += d === w.desig ? 6 : d ? -6 : -2;
  else if (d) score -= 3;
  const words = norm(w.variety).split(" ").filter((t) => t.length > 1 || /\d/.test(t));
  const hay = norm(`${e.name} ${e.v || ""}`).split(" ");
  if (words.length) {
    const hit = words.filter((t) => hay.includes(t)).length;
    score += hit * 3 - (words.length - hit) * 2;
  } else if (e.v) score -= 4;   // plain coin: prefer the plain entry
  return score;
}

/**
 * label fields {year, mint_mark, description, grade} -> {pcgs_no, name, score} or null.
 * A match needs at least the date, mint, denomination and strike to agree.
 */
export function matchLabel(index, c) {
  const w = wantedFromLabel(c);
  if (!w?.denom || !w.year) return null;
  const list = bucketsOf(index).get(`${denomRank(w.denom)}|${+w.year}`) || [];
  let best = null, second = -Infinity;
  for (const e of list) {
    const s = scoreEntry(w, e);
    if (s < 0) continue;
    if (!best || s > best.score) { if (best) second = best.score; best = { pcgs_no: e.pcgs, name: e.name, score: s }; }
    else if (s > second) second = s;
  }
  if (!best) return null;
  best.ambiguous = second === best.score;   // two equally good entries: flag it
  return best;
}
