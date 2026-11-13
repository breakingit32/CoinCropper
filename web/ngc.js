// NGC slab -> PCGS number, via the NGC coin ID.
//
// ngc-pcgs.json maps NGC coin IDs (NGC's catalog number for a coin type, e.g.
// 17373 = 1928 $1) to PCGS numbers. The label shows the cert number, not the
// coin ID, so the coin ID comes from:
//   1. the barcode, when it carries the coin ID next to the cert number, or
//   2. NGC's public cert verification page (ngccoin.com/certlookup/<cert>/<grade>/).

let mapPromise = null;
export function loadNgcMap(fetchImpl = globalThis.fetch) {
  if (!mapPromise) {
    mapPromise = fetchImpl("ngc-pcgs.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  }
  return mapPromise;
}
export function setNgcMap(map) { mapPromise = Promise.resolve(map); }   // for tests

// Barcode digits with the cert digits taken out; try what's left as a coin ID.
export function coinIdFromBarcode(raw, cert, map) {
  const digits = String(raw || "").replace(/\D/g, "");
  const c = String(cert || "").replace(/\D/g, "");
  if (!digits || !c || !digits.includes(c)) return null;
  const rest = digits.replace(c, "");
  const cands = new Set([rest]);
  for (let cut = 1; cut <= 3; cut++) { cands.add(rest.slice(0, -cut)); cands.add(rest.slice(cut)); }   // grade digits around it
  for (const k of cands) {
    const id = k.replace(/^0+/, "");
    if (id.length >= 4 && map[id]) return id;
  }
  return null;
}

// Coin ID out of NGC's cert verification page.
export function coinIdFromPage(html) {
  const s = String(html || "");
  const pats = [/NGC\s*Coin\s*I\.?D\.?[^0-9]{0,80}?(\d{4,7})/i, /coin-?explorer[^"'\s>]*?\/(\d{4,7})(?:\/|["'?#])/i,
    /["']?coin_?id["']?\s*[:=]\s*["']?(\d{4,7})/i, /\bcoinid=(\d{4,7})/i];
  for (const re of pats) { const m = re.exec(s); if (m) return m[1]; }
  return null;
}

export function makeNgc({ http, storage = globalThis.localStorage, fetchMap = loadNgcMap, api = null }) {
  const get = (k) => { try { return JSON.parse(storage?.getItem("ngc:" + k) || "null"); } catch { return null; } };
  const set = (k, v) => { try { storage?.setItem("ngc:" + k, JSON.stringify(v)); } catch { /* full */ } };

  async function fromPage(cert, gradeNum) {
    if (!cert || !gradeNum) return null;
    const k = `p:${cert}:${gradeNum}`;
    const hit = get(k);
    if (hit && (hit.id || Date.now() - hit.t < 864e5)) return hit.id;
    let id = null;
    try {
      const r = await http({ url: `https://www.ngccoin.com/certlookup/${encodeURIComponent(cert)}/${gradeNum}/`, method: "GET",
        headers: { Accept: "text/html" } });
      if (r.status === 200) id = coinIdFromPage(r.data);
    } catch { id = null; }
    set(k, { id, t: Date.now() });
    return id;
  }

  return {
    // {cert, raw (barcode), grade_num} -> {pcgs_no, ngc_id, via} or null
    async pcgsFor(coin) {
      const map = await fetchMap();
      if (!map || !Object.keys(map).length) return null;
      let id = coinIdFromBarcode(coin.raw, coin.cert, map), via = "NGC barcode";
      // NGC dealer API (cert -> coin ID, sometimes PCGS # directly). Its errors
      // (expired token, refused login) are passed on so the card can say so.
      if (!id && api?.configured()) {
        const k = `a:${coin.cert}`;
        let a = get(k);
        if (!a) { a = await api.lookup(coin.cert, coin.grade_num); if (a) set(k, a); }
        if (a?.pcgs_no) return { pcgs_no: a.pcgs_no, ngc_id: a.ngc_id, via: "NGC API" };
        if (a?.ngc_id) { id = a.ngc_id; via = "NGC API"; }
      }
      if (!id) { id = await fromPage(coin.cert, coin.grade_num); via = "NGC cert lookup"; }
      if (!id || !map[id]) return null;
      return { pcgs_no: String(map[id]), ngc_id: id, via };
    },
  };
}
