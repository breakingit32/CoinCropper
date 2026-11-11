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
  → **Save**. Optionally add a PCGS API token.
* Until CCE is set up it shows demo prices. Your login is stored only on the
  phone. Under **Advanced** you can still point the app at a server instead.

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
| `{barcode}`   | the full scanned barcode, exactly as read (best: CCE can look coins up by it) |
| `{cert}`      | `45678912`         |
| `{query}`     | `1881-S $1 MS65`   |

The parser reads any table on that page with a **Bid** and/or **Ask** column
and picks up Grade, Service, Dealer/Member, CAC and Date columns by name, so it
should handle CCE's layout without changes. If bids come back empty, save the
page's HTML and adjust `server/cce.py → parse_quotes`.

Please use this in line with your CCE membership terms. Results are cached for
10 minutes (`CACHE_SECONDS`) so a case of coins doesn't hammer the site.

### Identifying coins from the cert number (recommended)

A slab barcode only holds the **cert number**. CCE looks coins up by
**PCGS # + grade**, so for PCGS slabs set a free
[PCGS public API](https://www.pcgs.com/publicapi) token:

```ini
PCGS_API_TOKEN=...
```

The server then turns each cert into the coin name, PCGS # and grade
automatically. For NGC and others, the app uses what it can read from the
label (OCR) plus anything you type in **Fix coin details**.

## Development

```bash
pip install -r requirements.txt -r requirements-dev.txt
pytest                          # server
node tests/js/device.test.mjs   # app's on-device mode (needs Playwright)
```

* `server/labels.py`: barcode / QR / label-text parsing (no network)
* `server/pcgs.py`: PCGS cert lookup
* `server/cce.py`: CCE login, bid-table parser, demo data
* `server/main.py`: FastAPI app, serves `web/` and `/api/*`
* `web/`: the phone app (plain HTML/JS, no build step); `web/core.js` and
  `web/device.js` are the on-device copies of the server logic used by the APK
* `mobile/`: Android (Capacitor) project that bundles `web/` into an APK
