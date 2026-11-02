# Trip splitter

Expense splitting for a trip, built for Fynn, Tara and Max. Runs on your Mac mini and is shared to phones over Tailscale. No dependencies, no build step, Node 20 or newer.

## What it does

- **Cards**: Fynn and Tara can use the shared card, Fynn's own card, Tara's own card. Max has his own. A card's holders get credit for what it pays, equally. Add or edit cards from the Cards tab.
- **Households**: Fynn + Tara can settle as one household (default on), so Max sees one balance whichever of their cards paid. Switch off in Settings to settle individually.
- **Currency**: base currency is GBP. Each expense is entered in any currency (default GBP; USD, PAB and EUR are one tap, others under More). It is converted with ECB reference rates at the time you add it, and the rate is stored with the expense. If your card statement shows what you were really charged, type that under "Edit rate or actual charge" and it overrides the rate. PAB is treated as 1:1 with USD.
- **Splits**: equal between chosen people, or by shares.
- **Settle up**: suggested payments, mark as paid, undo. Export everything to CSV from Settings.
- **Live sync**: phones poll every 5 seconds, so everyone sees changes quickly.

All money is stored as whole pence/cents, and splits use largest-remainder rounding so totals always add up exactly.

## Run it

```sh
cd panama-splitter
node server.js            # http://127.0.0.1:3000
```

| Env var    | Default     | Meaning                                              |
|------------|-------------|------------------------------------------------------|
| `PORT`     | `3000`      | Port to listen on                                    |
| `HOST`     | `127.0.0.1` | Use `0.0.0.0` to be reachable on the Tailscale IP    |
| `DATA_DIR` | `./data`    | Where `trip.json` (your data) and `rates.json` live  |
| `TRIP_PIN` | none        | Optional shared PIN the app asks for on each phone   |

Your data is one file, `data/trip.json`, with a copy at `trip.json.bak` made at each start. Back it up if you care about it.

## Share it over Tailscale

Needs Tailscale on the Mac mini. In the Tailscale admin console, MagicDNS and HTTPS certificates should be enabled for `serve` to provide HTTPS.

**Private to your tailnet (recommended)**

```sh
node server.js                                  # keep this running (see launchd below)
tailscale serve --bg --https=443 3000
tailscale serve status                          # shows the https://<machine>.<tailnet>.ts.net address
```

Open that address on each phone. Tara and Max need to reach your tailnet: invite them as users, or share the Mac mini with their Tailscale accounts (Tailscale node sharing), and have them install the Tailscale app. To stop sharing: `tailscale serve --bg --https=443 3000 off`.

**Open to anyone with the link (no Tailscale app needed)**

```sh
TRIP_PIN=choose-something node server.js
tailscale funnel --bg 3000
```

This is reachable from the whole internet, so always set `TRIP_PIN`. The PIN gates the API; it is not a substitute for a strong password.

**Direct over the Tailscale IP, no HTTPS**

```sh
HOST=0.0.0.0 node server.js     # then browse to http://100.x.y.z:3000 from inside the tailnet
```

On iPhone, open the address in Safari, then Share, Add to Home Screen. It opens full screen with the header band under the status bar.

## Host it on Railway

No Tailscale and no Mac mini needed. Everyone opens a normal https link in Safari.

1. Put the folder in a GitHub repo (`git init`, commit, push). `data/` is git-ignored.
2. Railway: New Project, Deploy from GitHub repo, pick it. (`railway.json` already sets the start command and health check.)
3. Add a **volume** to the service (Command Palette `⌘K`, or right-click the canvas) and mount it at `/data`. The app picks the path up from `RAILWAY_VOLUME_MOUNT_PATH`. Without a volume, data would be wiped on each deploy, so the app refuses to start.
4. In the service Variables, set `TRIP_PIN` to a PIN you will share with Tara and Max. The app refuses to start on Railway without one, because the link is public.
5. Service Settings, Networking, **Generate Domain**. HTTPS is automatic.
6. Send the link and PIN. On iPhone: Safari, Share, Add to Home Screen.

Run a single instance only (the data is one JSON file). Redeploys keep the data because it lives on the volume. Use Settings, Download CSV now and then as a backup.

## Keep it running on the Mac mini

Save as `~/Library/LaunchAgents/com.fynn.trip-splitter.plist`, change the two paths (`which node` gives the first), then `launchctl load ~/Library/LaunchAgents/com.fynn.trip-splitter.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.fynn.trip-splitter</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/panama-splitter/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/panama-splitter</string>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>3000</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

## Tests

```sh
npm test
```

Covers money parsing and rounding, conversion, own-card and shared-card settlement (including a randomised check that applying the suggested payments always brings every balance to zero), the HTTP API, persistence across restarts, concurrent writes, the PIN, and the rates cache.

## Known limits

- Entering expenses needs a connection to the server. There is no offline queue yet.
- Exchange rates come from Frankfurter (ECB data) and are cached for 12 hours. If the service is unreachable, the last cached rates are used, and if there are none you can type a rate or the actual amount charged.
- One household is supported in the settings screen. Splits are equal or by shares, not exact amounts.
- Anyone who can reach the app can edit everything. Names are a convenience, not a login.
