"""Build web/pcgs-index.json: PCGS # -> description, for matching NGC labels.

Describes every PCGS number in web/ngc-pcgs.json through the PCGS public API
(GetCoinFactsByGrade), resuming from what's already in the index.

  python3 scripts/build_pcgs_index.py KEYS_FILE [--per-key 700] [--max-digits 5]

KEYS_FILE: PCGS API keys, whitespace separated (never commit it). Each key is
used for at most --per-key calls per run (free keys have a daily limit).
"""
import argparse, concurrent.futures as cf, json, os, pathlib, sys, threading, time, urllib.request, urllib.error

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "pcgs-index.json"
API = "https://api.pcgs.com/publicapi/coindetail/GetCoinFactsByGrade?PCGSNo={n}&GradeNo={g}&PlusGrade=false"


def call(key, n):
    for g in (60, 45, 65, 20):
        req = urllib.request.Request(API.format(n=n, g=g), headers={"Authorization": f"bearer {key}", "Accept": "application/json", "User-Agent": "CoinCropper-index/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                d = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 429):
                return "spent"
            continue
        except Exception:
            time.sleep(1)
            continue
        msg = f"{d.get('Message', '')} {d.get('ServerMessage', '')}".lower()
        if any(w in msg for w in ("limit", "quota", "exceed", "denied")):
            return "spent"
        if d.get("PCGSNo") and d.get("Name"):
            return {"n": str(d["PCGSNo"]), "name": d.get("Name"), "y": d.get("Year"), "d": d.get("Denomination"),
                    "m": d.get("MintMark") or "", "g": d.get("Designation") or "",
                    "v": ", ".join(x for x in (d.get("MajorVariety"), d.get("MinorVariety"), d.get("DieVariety")) if x),
                    "s": d.get("SeriesName") or ""}
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("keys")
    ap.add_argument("--per-key", type=int, default=700)
    ap.add_argument("--max-digits", type=int, default=5)
    ap.add_argument("--threads-per-key", type=int, default=2)
    a = ap.parse_args()
    keys = open(a.keys).read().split()
    table = json.load(open(ROOT / "web" / "ngc-pcgs.json"))
    index = json.load(open(OUT)) if OUT.exists() else {}
    misses = set(index.pop("_missing", []))
    # Regular US issues first (4-digit PCGS #s: half cents .. gold), then the rest.
    todo = sorted({p for p in table.values() if len(p) <= a.max_digits and p not in index and p not in misses},
                  key=lambda p: (len(p) != 4, int(p)))
    print(f"{len(index)} described, {len(todo)} to do, {len(keys)} keys x {a.per_key}", flush=True)
    lock = threading.Lock()
    it = iter(todo)
    done = [0]

    def worker(key):
        used = 0
        while used < a.per_key:
            with lock:
                n = next(it, None)
            if n is None:
                return
            r = call(key, n)
            used += 1
            if r == "spent":
                with lock:
                    todo.append(n)   # not processed
                return
            with lock:
                if r:
                    index[r["n"]] = {k: v for k, v in r.items() if k != "n" and v not in ("", None)}
                else:
                    misses.add(n)
                done[0] += 1
                if done[0] % 25 == 0:
                    save(index, misses)
                    print(f"  {done[0]} done, {len(index)} described", flush=True)

    # Several threads per key share that key's call budget.
    budget = {k: a.per_key for k in keys}
    def run(key):
        while True:
            with lock:
                if budget[key] <= 0:
                    return
                budget[key] -= 1
            n_before = done[0]
            if worker_once(key) is False:
                return
    def worker_once(key):
        with lock:
            n = next(it, None)
        if n is None:
            return False
        r = call(key, n)
        if r == "spent":
            with lock:
                budget[key] = 0
            return False
        with lock:
            if r:
                index[r["n"]] = {k: v for k, v in r.items() if k != "n" and v not in ("", None)}
            else:
                misses.add(n)
            done[0] += 1
            if done[0] % 25 == 0:
                save(index, misses)
                print(f"  {done[0]} done, {len(index)} described", flush=True)
        return True
    with cf.ThreadPoolExecutor(len(keys) * a.threads_per_key) as ex:
        list(ex.map(run, [k for k in keys for _ in range(a.threads_per_key)]))
    save(index, misses)
    print(f"finished: {len(index)} described, {len(misses)} not found", flush=True)


def save(index, misses):
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps({**index, "_missing": sorted(misses)}, separators=(",", ":")))
    os.replace(tmp, OUT)


if __name__ == "__main__":
    main()
