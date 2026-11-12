// Find a coin's PCGS number (and Greysheet id) from what its label says, using
// the Greysheet catalog. Needed for NGC (and other non-PCGS) slabs: CCE,
// Greysheet pricing and the PCGS guide are all keyed by PCGS number.
//
// The catalog is a tree of nodes (U.S. Coins > Dimes > Mercury Dimes ...)
// whose leaves hold collectibles (CoinDate, MintMark, DenominationShort,
// StrikeType, Variety, Desg, PcgsNumber, Gsid). Nodes and collectibles are
// cached on the phone for good, so each series is downloaded once.

import { GREYSHEET } from "./grading.js";

// ------------------------------------------------------------- label text -> wanted coin

// Denomination as printed on labels -> words used in catalog node names.
const DENOMS = [
  [/^(1\/2C|HALF ?C(ENT)?)$/i, ["half cent"]],
  [/^1C$/i, ["cent", "penny"]],
  [/^2C$/i, ["two cent", "2c"]],
  [/^3C(N|S)?$/i, ["three cent", "3c"]],
  [/^H10C$/i, ["half dime"]],
  [/^5C$/i, ["nickel", "five cent", "5c"]],
  [/^10C$/i, ["dime"]],
  [/^20C$/i, ["twenty cent", "20c"]],
  [/^25C$/i, ["quarter"]],
  [/^50C$/i, ["half dollar"]],
  [/^(S?\$1|T\$1)$/i, ["dollar"]],
  [/^G\$1$/i, ["gold dollar"]],
  [/^\$2(\.50)?$/i, ["quarter eagle", "\\$2.50"]],
  [/^\$3$/i, ["three dollar", "\\$3"]],
  [/^\$5$/i, ["half eagle", "\\$5"]],
  [/^\$10$/i, ["eagle", "\\$10"]],
  [/^\$20$/i, ["double eagle", "\\$20"]],
];
const DENOM_TOKEN = /^(1\/2C|H10C|\d+C[NS]?|[SGT]?\$\d+(\.\d+)?)$/i;
const DESIG_WORDS = { BN: "BN", RB: "RB", RD: "RD", CAM: "CAM", CAMEO: "CAM", DCAM: "DCAM", UCAM: "DCAM",
  "ULTRA CAMEO": "DCAM", PL: "PL", DPL: "DMPL", DMPL: "DMPL", FB: "FB", FBL: "FBL", FS: "FS", FH: "FH", FT: "FT" };

/**
 * From label fields: {year, mint_mark, description, grade} -> what to look for.
 * description is the label's first line, e.g. "1916 D 10C", "1909 S VDB 1C",
 * "1937 D 3 LEGS 5C", "1955 DOUBLED DIE OBV 1C", "1900-O/CC S$1".
 */
export function wantedFromLabel(c) {
  const line = String(c.description || "").toUpperCase().replace(/\s+/g, " ").trim();
  const ym = /\b(1[6-9]\d{2}|20\d{2})(?:\/\d{1,2})?/.exec(line);
  const year = c.year || (ym && ym[1]);
  if (!year) return null;
  const toks = line.slice(ym ? ym.index + ym[0].length : 0).replace(/^[-\s]+/, "").split(/[\s]+/).filter(Boolean);
  let mint = c.mint_mark || null;
  if (toks[0] && /^(CC|[PDSOWC])(\/(CC|[PDSO]))?$/.test(toks[0])) mint = mint || toks[0].split("/")[0];
  if (toks[0] && /^(CC|[PDSOWC])/.test(toks[0]) && toks[0].length <= 5 && !DENOM_TOKEN.test(toks[0])) toks.shift();
  const di = toks.findIndex((t) => DENOM_TOKEN.test(t));
  const denom = di >= 0 ? toks[di] : null;
  const variety = (di >= 0 ? toks.slice(0, di).concat(toks.slice(di + 1)) : toks)
    .filter((t) => !/^[-/]$/.test(t)).join(" ");
  const g = String(c.grade || "").toUpperCase();
  const proof = /^(PR|PF|SP)/.test(g);
  const desigs = Object.keys(DESIG_WORDS).filter((k) => new RegExp(`\\b${k}\\b`).test(g)).map((k) => DESIG_WORDS[k]);
  return { year: String(year), mint: mint && mint !== "P" ? mint : null, denom, variety, proof, desig: desigs[0] || null };
}

const denomWords = (denom) => (DENOMS.find(([re]) => re.test(denom || "")) || [null, []])[1];

// ------------------------------------------------------------- scoring

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export function scoreCollectible(w, x) {
  // Date: "1916-D" / "1916" / "1916/5"
  const date = norm(x.CoinDate);
  if (!date.startsWith(w.year)) return -1;
  const mint = norm(x.MintMark) || (/^\d{4} ([A-Z]{1,2})\b/.exec(date)?.[1] ?? "");
  if ((w.mint || "") !== (mint === "P" ? "" : mint)) return -1;
  const strike = norm(x.StrikeType);
  const isProof = /PROOF|PR\b|PF\b/.test(strike) || /\bPR\b|PROOF/.test(norm(x.Name)) || norm(x.Prefix) === "PR";
  if (isProof !== w.proof) return -1;
  let score = 10;
  // Designation (BN/RB/RD, CAM/DCAM, FB...): PCGS numbers differ per designation.
  const desg = norm(x.Desg);
  if (w.desig) score += desg.includes(w.desig) ? 6 : desg ? -6 : -2;
  else if (desg) score -= 3;
  // Variety words (VDB, DOUBLED DIE, 3 LEGS, STRONG REVERSE ...)
  const vx = norm([x.Variety, x.Variety2, x.Other, x.Name].join(" "));
  const vw = norm(w.variety).split(" ").filter((t) => t.length > 1 || /\d/.test(t));
  if (vw.length) {
    const hit = vw.filter((t) => vx.split(" ").includes(t)).length;
    score += hit * 3 - (vw.length - hit) * 2;
  } else if (norm(x.Variety)) score -= 4;   // plain coin: prefer the plain entry
  return score;
}

// ------------------------------------------------------------- catalog walker

export function makeCatalog({ http, getKeys, storage = globalThis.localStorage }) {
  const get = (k) => { try { return JSON.parse(storage?.getItem("gsc:" + k) || "null"); } catch { return null; } };
  const set = (k, v) => { try { storage?.setItem("gsc:" + k, JSON.stringify(v)); } catch { /* full */ } };
  let calls = 0;

  async function api(name, params) {
    const { gsKey, gsToken } = getKeys();
    const q = new URLSearchParams({ ...params, ApiLevel: "advanced" });
    calls++;
    const r = await http({ url: `${GREYSHEET}/${name}?${q}`, method: "GET", responseType: "json",
      headers: { "x-api-token": gsToken, "x-api-key": gsKey, Accept: "application/json" } });
    const data = typeof r.data === "string" ? JSON.parse(r.data || "null") : r.data;
    if (r.status === 401 || r.status === 403 || data?.PermitAccess === false)
      throw new Error(`Greysheet catalog: ${data?.AccessDeniedMessage || data?.ResponseStatus?.Message || "access denied"}`);
    if (r.status !== 200) throw new Error(`Greysheet catalog HTTP ${r.status}`);
    return data?.Data || [];
  }

  const slimNode = (n) => ({ id: n.Id, name: n.Name || "", nodes: n.NodeChildrenCountLive || 0, items: n.CollectibleChildrenCountLive || 0 });
  async function children(id) {
    const k = "n:" + id;
    let v = get(k);
    if (!v) {
      const data = await api("GetNodeChildrenRequest", { NodeId: String(id) });
      // Some responses wrap the node with ChildNodes; others list the children.
      const list = data.length === 1 && data[0].Id === id && data[0].ChildNodes ? data[0].ChildNodes : data;
      v = list.map(slimNode);
      set(k, v);
    }
    return v;
  }
  async function root() {
    let v = get("root");
    if (!v) { const d = await api("GetNodeRequest", { NodeId: "1" }); v = d.map(slimNode); set("root", v); }
    return v;
  }
  const slimItem = (x) => ({ Gsid: x.Gsid, PcgsNumber: x.PcgsNumber, NgcId: x.NgcId, Name: x.Name, CoinDate: x.CoinDate,
    MintMark: x.MintMark, DenominationShort: x.DenominationShort, StrikeType: x.StrikeType, Variety: x.Variety,
    Variety2: x.Variety2, Desg: x.Desg, Other: x.Other, Prefix: x.Prefix });
  async function items(id) {
    const k = "c:" + id;
    let v = get(k);
    if (!v) { v = (await api("GetCollectibleByNodeRequest", { NodeId: String(id) })).map(slimItem); set(k, v); }
    return v;
  }

  // Year range from a node name like "Mercury Dimes (1916-1945)" or "Capped Bust 1809-1837".
  const yearRange = (name) => {
    const m = /(1[6-9]\d{2}|20\d{2})\s*[-–]\s*(1[6-9]\d{2}|20\d{2}|date|present)/i.exec(name);
    return m ? [+m[1], /\d/.test(m[2]) ? +m[2] : 9999] : null;
  };

  async function find(w) {
    const words = denomWords(w.denom);
    if (!words.length) return null;
    // 1. U.S. coins node, then the denomination node.
    const top = await root();
    let us = top.find((n) => /u\.?\s?s\.?\s*coins|united states coins/i.test(n.name));
    if (!us) {
      for (const n of top) {
        const kids = await children(n.id);
        us = kids.find((k) => /u\.?\s?s\.?\s*coins|united states coins/i.test(k.name));
        if (us) break;
      }
    }
    if (!us) throw new Error("Greysheet catalog: U.S. coins section not found");
    const denomRe = new RegExp(`\\b(${words.join("|")})s?\\b`, "i");
    const notRe = w.denom && /^1C$/i.test(w.denom) ? /half|two|three|flying eagle/i : w.denom && /^10C$/i.test(w.denom) ? /half/i
      : w.denom && /^(S?\$1)$/i.test(w.denom) ? /gold|half|eagle/i : w.denom && /^\$10$/i.test(w.denom) ? /half|quarter|double/i : null;
    const denNodes = (await children(us.id)).filter((n) => denomRe.test(n.name) && !(notRe && notRe.test(n.name)));
    // 2. Walk down, skipping series whose year range excludes the coin and
    //    proof sections for business strikes (and vice versa when labelled).
    const yr = +w.year;
    const queue = [...denNodes];
    let best = null;
    while (queue.length) {
      const n = queue.shift();
      const r = yearRange(n.name);
      if (r && (yr < r[0] || yr > r[1])) continue;
      if (/\bproof\b/i.test(n.name) && !w.proof) continue;
      if (n.items) {
        for (const x of await items(n.id)) {
          const s = scoreCollectible(w, x);
          if (s >= 0 && (!best || s > best.score)) best = { score: s, item: x, node: n.name };
        }
        if (best && best.score >= 16) break;      // confident match
      }
      if (n.nodes) queue.push(...(await children(n.id)));
      if (calls > 60) break;                      // safety limit per lookup
    }
    return best;
  }

  return {
    configured() { const k = getKeys(); return !!(k.gsKey && k.gsToken); },
    calls: () => calls,
    // label fields -> {pcgs_no, gsid, name, ngc_id, node, score} or null
    async lookup(c) {
      const w = wantedFromLabel(c);
      if (!w || !w.denom || !this.configured()) return null;
      const key = `m:${w.year}|${w.mint}|${w.denom}|${w.variety}|${w.proof}|${w.desig}`;
      const hit = get(key);
      if (hit !== null) return hit.none ? null : hit;
      calls = 0;
      const best = await find(w);
      const out = best ? { pcgs_no: best.item.PcgsNumber ? String(best.item.PcgsNumber).replace(/^0+/, "") : null,
        gsid: best.item.Gsid, name: best.item.Name, ngc_id: best.item.NgcId || null, node: best.node, score: best.score } : { none: true };
      set(key, out);
      return out.none ? null : out;
    },
  };
}
