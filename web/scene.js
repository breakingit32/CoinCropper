// Scene map: remembers where every slab in the case is, so cards stay put while
// the camera moves and slabs already read don't need to be read again.
//
// Each slab gets a pose in a fixed "case" (world) coordinate frame.  Every
// frame, the slabs that are recognised are matched to the map and a similarity
// transform (scale, rotation, shift) from case to screen is fitted to them;
// all remembered slabs are then projected onto the screen with it, including
// ones whose label or barcode can't be read in that frame.
//
// Slabs seen while nothing known is in view start a separate "island"; when a
// frame shows slabs from two islands at once, the islands are merged.

const now0 = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ------------------------------------------------------------ similarity transforms
// screen = M * world + t,  M = [[a, -b], [b, a]]   (scale s = |(a,b)|, angle r = atan2(b, a))

export const apply = (T, p) => [T.a * p[0] - T.b * p[1] + T.tx, T.b * p[0] + T.a * p[1] + T.ty];
export function invert(T) {
  const d = T.a * T.a + T.b * T.b || 1;
  const a = T.a / d, b = -T.b / d;
  return { a, b, tx: -(a * T.tx - b * T.ty), ty: -(b * T.tx + a * T.ty) };
}
export const compose = (A, B) => ({   // A after B
  a: A.a * B.a - A.b * B.b, b: A.b * B.a + A.a * B.b,
  tx: A.a * B.tx - A.b * B.ty + A.tx, ty: A.b * B.tx + A.a * B.ty + A.ty,
});
const scaleOf = (T) => Math.hypot(T.a, T.b);
const angleOf = (T) => Math.atan2(T.b, T.a);
export const identity = () => ({ a: 1, b: 0, tx: 0, ty: 0 });

export function poseTo(T, pose) {
  const [cx, cy] = apply(T, [pose.cx, pose.cy]);
  const s = scaleOf(T);
  return { cx, cy, w: pose.w * s, h: pose.h * s, angle: pose.angle + angleOf(T) };
}

// Least-squares similarity from world poses to screen poses.
export function fit(pairs) {
  if (!pairs.length) return null;
  if (pairs.length === 1) {
    const [w, s] = pairs[0];
    const k = s.w / (w.w || 1), r = s.angle - w.angle;
    const a = k * Math.cos(r), b = k * Math.sin(r);
    return { a, b, tx: s.cx - (a * w.cx - b * w.cy), ty: s.cy - (b * w.cx + a * w.cy) };
  }
  const n = pairs.length;
  let px = 0, py = 0, qx = 0, qy = 0;
  for (const [w, s] of pairs) { px += w.cx; py += w.cy; qx += s.cx; qy += s.cy; }
  px /= n; py /= n; qx /= n; qy /= n;
  let sxx = 0, num_a = 0, num_b = 0;
  for (const [w, s] of pairs) {
    const x = w.cx - px, y = w.cy - py, u = s.cx - qx, v = s.cy - qy;
    sxx += x * x + y * y; num_a += x * u + y * v; num_b += x * v - y * u;
  }
  if (sxx < 1e-6) return fit([pairs[0]]);
  const a = num_a / sxx, b = num_b / sxx;
  return { a, b, tx: qx - (a * px - b * py), ty: qy - (b * px + a * py) };
}

// Fit that ignores matches that disagree (e.g. a misread cert pinned to the
// wrong slab): try each pair of matches as the basis, keep the transform most
// matches agree with, then refit on those.
function robustFit(pairs) {
  if (pairs.length < 3) return { T: fit(pairs), inliers: pairs };
  const tol = (p) => Math.max(25, 0.35 * p[1].w);
  const agree = (T) => pairs.filter((p) => {
    const q = apply(T, [p[0].cx, p[0].cy]);
    return Math.hypot(q[0] - p[1].cx, q[1] - p[1].cy) < tol(p);
  });
  let best = pairs;
  let bestCount = 0;
  const n = Math.min(pairs.length, 25);
  for (let i = 0; i < n; i++) for (let k = i + 1; k < n; k++) {
    const T = fit([pairs[i], pairs[k]]);
    const inl = agree(T);
    if (inl.length > bestCount) { bestCount = inl.length; best = inl; }
    if (bestCount === pairs.length) return { T: fit(pairs), inliers: pairs };
  }
  return bestCount >= 2 ? { T: fit(best), inliers: best } : { T: fit(pairs), inliers: pairs };
}

function blendT(prev, next, k) {
  if (!prev) return next;
  return { a: prev.a + (next.a - prev.a) * k, b: prev.b + (next.b - prev.b) * k,
    tx: prev.tx + (next.tx - prev.tx) * k, ty: prev.ty + (next.ty - prev.ty) * k };
}

const overlap = (p, q) => {
  // rough: centre distance relative to size (slabs are similar in size)
  const d = Math.hypot(p.cx - q.cx, p.cy - q.cy);
  return d < 0.45 * Math.min(p.w, q.w);
};

// ------------------------------------------------------------ map

export class SceneMap {
  constructor({ confirmReads = 2, confirmMs = 2500, holdMs = 700, smooth = 0.6 } = {}) {
    Object.assign(this, { confirmReads, confirmMs, holdMs, smooth });
    this.slabs = new Map();     // key -> {key, world, island, seen, firstSeen, lastSeen}
    this.islands = new Map();   // id  -> {T, at}
    this.pending = new Map();   // unconfirmed text reads: key -> {count, first, last}
    this.aliases = new Map();   // misread / renamed key -> key
    this.nextIsland = 1;
  }

  resolve(key) { let k = key, n = 0; while (this.aliases.has(k) && n++ < 10) k = this.aliases.get(k); return k; }

  // Rename (e.g. barcode value -> cert once the label is read).
  rename(from, to) {
    if (from === to) return;
    const a = this.slabs.get(from);
    if (a && !this.slabs.has(to)) { a.key = to; this.slabs.set(to, a); }
    this.slabs.delete(from);
    this.aliases.set(from, to);
  }

  forget() { this.slabs.clear(); this.islands.clear(); this.pending.clear(); this.aliases.clear(); }

  /**
   * dets: [{key, slab:{cx,cy,w,h,angle}, sure}]  sure = barcode-confirmed (checksummed)
   * Returns {visible: [{key, slab, live}], accepted: Set(keys detected and accepted this frame)}
   */
  update(dets, t = now0()) {
    // 1. Known vs new; text-only reads must repeat before a new slab is created.
    const known = [], fresh = [];
    for (const d of dets) {
      const key = this.resolve(d.key);
      const det = { ...d, key };
      if (this.slabs.has(key)) { known.push(det); continue; }
      if (!d.sure) {
        const p = this.pending.get(key) || { count: 0, first: t };
        if (t - p.first > this.confirmMs) { p.count = 0; p.first = t; }
        p.count++; p.last = t;
        this.pending.set(key, p);
        if (p.count < this.confirmReads) continue;
      }
      fresh.push(det);
    }
    for (const [k, p] of this.pending) if (t - p.last > this.confirmMs) this.pending.delete(k);

    // 2. Localise: the island with the most matches this frame. The camera
    //    estimate is only trusted ("good") when 2+ matches agree on it; one
    //    slab's own outline is too rough to place the others from.
    const byIsland = new Map();
    for (const d of known) {
      const s = this.slabs.get(d.key);
      (byIsland.get(s.island) || byIsland.set(s.island, []).get(s.island)).push([s.world, d.slab, d.key]);
    }
    let main = null, mainT = null, mainPairs = [], inlierKeys = new Set(), good = false;
    for (const [id, pairs] of byIsland) {
      if (pairs.length > mainPairs.length) { main = id; mainPairs = pairs; }
    }
    if (main != null) {
      const { T, inliers } = robustFit(mainPairs);
      inlierKeys = new Set(inliers.map((p) => p[2]));
      good = inlierKeys.size >= 2;
      const isl = this.islands.get(main);
      mainT = isl && t - isl.at < 400 ? blendT(isl.T, T, this.smooth) : T;
      this.islands.set(main, { T: mainT, at: t, good });
      // 3. Other islands in view: merge them into the main one. A one-slab
      //    island just takes the slab's position as seen now; bigger islands
      //    need both sides pinned down (2+ agreeing matches) to line them up.
      const invMain = invert(T);   // this frame's own fit (smoothing is for display only)
      for (const [id, pairs] of byIsland) {
        if (id === main) continue;
        const members = [...this.slabs.values()].filter((s) => s.island === id);
        let toMain = null;
        if (members.length === 1) {
          members[0].world = poseTo(invMain, pairs[0][1]);
          members[0].island = main;
          this.islands.delete(id);
          continue;
        }
        if (!good || pairs.length < 2) continue;
        const { T: T2, inliers: in2 } = robustFit(pairs);
        if (in2.length < 2) continue;
        toMain = compose(invMain, T2);   // other world -> main world
        for (const s of members) { s.world = poseTo(toMain, s.world); s.island = main; }
        this.islands.delete(id);
      }
      if (good) {
        // 4. Refine remembered positions from what's seen.
        const inv = invMain, k = inlierKeys.size >= 3 ? 0.3 : 0.15;
        for (const d of known) {
          if (!inlierKeys.has(d.key)) continue;
          const s = this.slabs.get(d.key);
          const w = poseTo(inv, d.slab);
          for (const f of ["cx", "cy", "w", "h"]) s.world[f] += (w[f] - s.world[f]) * k;
        }
      }
    }

    // 5. New slabs: placed in the main island, or start a new one.
    if (fresh.length && main == null) {
      main = this.nextIsland++;
      mainT = identity();
      good = true;
      this.islands.set(main, { T: mainT, at: t, good: true });
    }
    const inv = main != null && byIsland.has(main) ? invert(robustFit(mainPairs).T) : mainT ? invert(mainT) : null;
    const liveDets = new Map(known.map((d) => [d.key, d]));
    for (const d of fresh) {
      // Same spot on screen as a slab read in this frame, or (with a good
      // camera estimate) as a mapped slab: it's that slab, read differently.
      // Two slabs can't be in the same place.
      let dup = [...liveDets.values()].find((o) => o.key !== d.key && overlap(o.slab, d.slab));
      const world = poseTo(inv, d.slab);
      if (!dup && good) {
        const m = [...this.slabs.values()].find((s) => s.island === main && overlap(s.world, world));
        if (m) dup = { key: m.key };
      }
      if (dup) {
        this.aliases.set(d.key, dup.key);
        if (!liveDets.has(dup.key)) liveDets.set(dup.key, { ...d, key: dup.key });
        continue;
      }
      this.slabs.set(d.key, { key: d.key, world, island: main, seen: 1, firstSeen: t, lastSeen: t });
      this.pending.delete(d.key);
      liveDets.set(d.key, d);
    }
    for (const d of liveDets.values()) { const s = this.slabs.get(d.key); if (s) { s.seen++; s.lastSeen = t; } }

    // 6. Output: slabs read this frame at their detected position; the other
    //    remembered slabs of this island only when the camera estimate is good.
    const visible = [];
    for (const d of liveDets.values()) visible.push({ key: d.key, slab: d.slab, live: true });
    let isl = main != null ? this.islands.get(main) : null;
    if (!isl) {   // nothing recognised this frame: hold the last good view briefly
      for (const [id, x] of this.islands) if (t - x.at < this.holdMs && (!isl || x.at > isl.at)) { isl = x; main = id; }
    }
    if (isl?.good) {
      for (const s of this.slabs.values()) {
        if (s.island !== main || liveDets.has(s.key)) continue;
        visible.push({ key: s.key, slab: poseTo(isl.T, s.world), live: false });
      }
    }
    return { visible, accepted: new Set(liveDets.keys()) };
  }

  size() { return this.slabs.size; }
}
