# CoinCropper

Point your phone's camera at a case of certified (slabbed) coins and see the
current **CCE (Certified Coin Exchange) bid** floating over each slab, live, in AR.

```
 ┌──────────── phone (web app) ────────────┐        ┌──────── server (Python) ────────┐
 │ camera → barcode detector (many slabs)  │  POST  │ parse cert / service / grade    │
 │ AR cards anchored to each label         │ ─────▶ │ PCGS cert lookup (optional)     │
 │ tap → bid/ask table, edit, OCR label    │ ◀───── │ log into CCE, read bid table    │
 └─────────────────────────────────────────┘  JSON  └─────────────────────────────────┘
```

## What it does

* Reads every slab barcode / QR code in view at once (PCGS, NGC, CACG, ANACS, ICG).
  Uses the phone's built-in `BarcodeDetector` on Android Chrome, and a tiled
  ZXing scanner everywhere else (iPhone Safari).
* Pins a card to each label: coin, grade and **high bid**. Cards follow the
  slabs as you move the phone; hit **❚❚** to freeze the frame and read them.
* Tap a card for every bid and ask (dealer, grade, CAC), a link to the coin on
  CCE and the PCGS/NGC cert verification page.
* **Fix coin details** lets you correct grade / PCGS # / description, or
  **Read label text** to OCR the label (Tesseract) when the barcode alone isn't
  enough to identify the coin.
* The bottom pill keeps a running count and **total high bid for the case**;
  export it as CSV.
* Installable as a home-screen app (PWA), flashlight toggle where supported.

## Install on your phone

1. **Put the server online (free).** Sign in at [render.com](https://render.com)
   with GitHub → **New → Blueprint** → pick this repo. Render reads
   `render.yaml` and gives you an address like `https://coincropper.onrender.com`.
   (Any host that runs Docker works too; there's a `Dockerfile`.)
2. **Open that address on your phone.**
   * **iPhone (Safari):** Share button → **Add to Home Screen** → Add.
   * **Android (Chrome):** ⋮ menu → **Install app** / **Add to Home screen**.
3. Open **CoinCropper** from your home screen → **Start camera** → Allow.

It starts with demo prices. For live bids, add your CCE login in Render →
your service → **Environment** (`CCE_MODE=live`, `CCE_USER_ID`,
`CCE_PASSWORD`, `CCE_SEARCH_URL`, optionally `PCGS_API_TOKEN`), see
[Connecting to CCE](#connecting-to-cce). Render's free plan sleeps when idle,
so the first scan after a break can take ~30 seconds.

### Android app (APK): no server needed

There's also a real Android app in `mobile/` (Capacitor). **It runs entirely on
the phone:** it signs in to CCE itself with your member login, keeps the
session like a browser would, and reads the bids directly. No Render or
other server required. (The website and iPhone versions still use the server,
because browsers won't let one site read another site's pages.)

* **Get the APK:** GitHub → **Actions** → **Android APK** → latest run →
  download **CoinCropper-apk**. Or build it yourself with the Android SDK:
  `cd mobile && npm ci && npm run apk`
  (output: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`).
* **Install:** open the APK on the phone and allow *Install unknown apps* when
  Android asks.
* **Set up:** tap ⚙ → enter your CCE **user id**, **password** and **bid page
  address** (see [Connecting to CCE](#connecting-to-cce); you can paste the
  full `https://www.certifiedcoinexchange.com/…` address) → **Test CCE login**
  → **Save**. Optionally import your grading API keys (see [Grading APIs](#grading-apis-identify-coins-from-the-cert-recommended)).
* **Scanning:** the app runs Google ML Kit on every camera frame for both
  **barcodes and label text**. If a barcode can't be read, the slab is still
  identified from its label, e.g. PCGS's `7268.64/2401136` line (PCGS #,
  grade, cert) or an NGC cert like `6521437-005`, and a card appears on it.
  For coins read from text only, `{barcode}` sends the cert number.
* **Remembers the case:** the app keeps a map of where each slab sits.
  Every frame the slabs it recognises tell it how the camera moved, so cards
  stay on slabs whose label or barcode can't be read in that frame (dashed
  outline), and come straight back when you pan back. A cert read only from
  text must be read the same way twice before it counts, and a misread that
  lands on a known slab is treated as that slab.
* **Each coin is looked up once:** scans are saved on the phone, so seeing a
  coin again (even after restarting the app) doesn't look it up again; bids
  older than 12 hours are refreshed once when the coin is seen. **Clear** in
  the case list forgets everything.
* Until CCE is set up it shows demo prices. Your login is stored only on the
  phone. Under **Advanced** you can still point the app at a server instead.

**Built-in login and keys (your own builds):** put them in
`mobile/secrets.local.json` (git-ignored; never commit it):

```json
{ "cceUser": "…", "ccePass": "…", "pcgsTokens": ["key1", "key2"],
  "cacgKey": "…", "cacgToken": "…", "gsKey": "…", "gsToken": "…", "ngcToken": "…" }
```

`npm run apk` writes them into the APK (`builtin.local.js`), so the app starts
signed in with nothing to type. Values typed in Settings override them. Anyone
who has that APK file can read them, so don't share it. The website and
GitHub builds never include them.

It's a debug-signed build for installing yourself; publishing to Google Play
would need a release signing key.

## Run it on your own computer

```bash
pip install -r requirements.txt
cp .env.example .env        # then edit, see below
uvicorn server.main:app --host 0.0.0.0 --port 8000
```

Phones only allow camera access on **HTTPS** pages, so open the app through an
HTTPS address, e.g.

* `cloudflared tunnel --url http://localhost:8000` (or `ngrok http 8000`) and
  open the `https://…` URL it prints on your phone, or
* `uvicorn … --ssl-keyfile key.pem --ssl-certfile cert.pem` with a cert from
  `mkcert`, or
* deploy the server anywhere that gives you HTTPS.

On the phone: tap **Start camera**, allow camera access, and hover over the
case. Use *Share → Add to Home Screen* to install it.

Out of the box `CCE_MODE=mock`, so you get realistic **demo prices** (the pill
in the top-right says *Demo prices*) and can try everything without an account.

## Connecting to CCE

CCE only shows numismatic bids to logged-in members and has no public API, so
the server signs in with your member account and reads the bid table from a
member page. Your password stays on the server; the phone never sees it.

In `.env`:

```ini
CCE_MODE=live
CCE_USER_ID=your-cce-user-id
CCE_PASSWORD=your-cce-password
CCE_SEARCH_URL=/path/to/member/bid/page?barcode={barcode}
```

`CCE_SEARCH_URL` is the member-area page that shows bids for **one coin**.
Log in to CCE in a desktop browser, open the bids for any coin, and copy that
page's address, replacing the coin-specific parts with placeholders:

| Placeholder   | Example            |
|---------------|--------------------|
| `{pcgs_no}`   | `7144`             |
| `{grade}`     | `MS65`, `PR69 DCAM`|
| `{grade_num}` | `65`               |
| `{service}`   | `PCGS`, `NGC`      |
| `{barcode}`   | the full scanned barcode, exactly as read (best: CCE can look coins up by it); the cert number if only the label text was read |
| `{cert}`      | `45678912`         |
| `{query}`     | `1881-S $1 MS65`   |

The parser reads any table on that page with a **Bid** and/or **Ask** column
and picks up Grade, Service, Dealer/Member, CAC and Date columns by name, so it
should handle CCE's layout without changes. If bids come back empty, save the
page's HTML and adjust `server/cce.py → parse_quotes`.

Please use this in line with your CCE membership terms. Results are cached for
10 minutes (`CACHE_SECONDS`) so a case of coins doesn't hammer the site.

### Grading APIs: identify coins from the cert (recommended)

With API keys, each slab is looked up in the grading service's own records
from its barcode or the cert number read off the label:

* **PCGS** (`api.pcgs.com`): coin, grade, PCGS #, PCGS price guide,
  population, and that coin's own auction history. Several keys can be
  given; when one is refused or reaches its daily limit the next is used.
  Old 7-digit certs are padded to 8 digits automatically.
* **CAC** (`api.cacgrading.com`): CAC sticker (Green/Gold) on PCGS and NGC
  coins, and CACG's own certs.
* **Greysheet** (CDN Public API, `cpgpublicapiv2.greysheet.com`): Greysheet
  wholesale value for the coin's PCGS # and grade (the CAC price for CAC
  coins), plus CPG retail. Uses the Advanced tier (`ApiLevel=advanced`) and
  falls back to Basic (retail only) if the key doesn't have it. Cards show
  the CCE bid, else Greysheet, else the PCGS guide.
* **NGC and other slabs** (no PCGS #): the app finds the coin in the
  **Greysheet catalog** from its label (year, mint, denomination, variety,
  proof/business strike, designation such as BN/RB/RD, CAM, FB) and uses its
  PCGS # for CCE, Greysheet prices and the PCGS guide. Catalog pages are kept
  on the phone, so each series is downloaded once. (Android app; needs the
  Greysheet key.)
* **NGC** dealer API: the token can be stored but isn't used yet.

Results are cached for a week (on the phone in the Android app), so a case
costs each lookup once. When CCE has no bid, cards show the PCGS guide value.

* **Android app:** ⚙ → *Grading APIs* → **Import keys file…** (JSON:
  `{"pcgs": ["key1", "key2"], "cacg_key": "…", "cacg_token": "…", "ngc_token": "…"}`)
  or paste them in. Keys are stored only on the phone.
* **Server:** `PCGS_API_TOKEN=key1,key2,…`, `CACG_API_KEY`, `CACG_API_TOKEN`,
  `GREYSHEET_API_KEY`, `GREYSHEET_API_TOKEN`.

Never commit keys to the repository.

## Development

```bash
pip install -r requirements.txt -r requirements-dev.txt
pytest                          # server
node tests/js/device.test.mjs   # app's on-device mode (needs Playwright)
node tests/js/scene.test.mjs    # remembered case layout
node tests/js/slab.test.mjs     # label model on real labels
node tests/js/catalog.test.mjs  # PCGS # for NGC slabs from the Greysheet catalog
```

* `server/labels.py`: barcode / QR / label-text parsing (no network)
* `server/grading.py`, `web/grading.js`: PCGS and CAC API lookups
* `server/cce.py`: CCE login, bid-table parser, demo data
* `web/slab.js`: label layout model (finds each slab's rectangle and fields)
* `web/scene.js`: remembered case layout (camera motion from recognised slabs)
* `server/main.py`: FastAPI app, serves `web/` and `/api/*`
* `web/`: the phone app (plain HTML/JS, no build step); `web/core.js` and
  `web/device.js` are the on-device copies of the server logic used by the APK
* `mobile/`: Android (Capacitor) project that bundles `web/` into an APK
