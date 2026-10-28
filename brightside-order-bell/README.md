# 🛎️ Brightside Order Bell

Shopify online order → Slack channel post with a bell GIF, the parsed UTM breakdown, and the full landing URL for QA. A channel canvas tab keeps a running tally for **Lifetime / MTD / WTD** (order count, revenue, source breakdown) plus a ledger of recent orders (date, order #, value, source/medium, campaign, ad name, items).

Runs on Cloudflare Workers + D1 (SQLite). Free tier is plenty for this volume.

## What a post looks like

```
[bell gif]
🔔 New online order #1234 — $54.00
Landing Page = https://drinkbrightside.com/pages/smitten-with-the-small-stuff
Source = meta
Medium = paid-social
Campaign = sales-excl-customers
Content = sales-LAL-customers
Term = Ad name = smitten-if-your-vibe-cali-7s
Items
• 2× Product (12-pack)
Full URL (for QA)
https://drinkbrightside.com/pages/smitten-with-the-small-stuff?&utm_source=meta&...
Placed Sep 27, 2026, 4:57 PM EDT · attribution: landing_site · referrer: l.facebook.com
```

If the visit had no UTMs, Source/Medium fall back to the referrer domain (`google.com / referral`) or `(direct) / (none)`, and the post says it was inferred.

## Setup (about 20 minutes)

### 1. Slack app
1. Create the channel (e.g. `#online-orders`).
2. Go to api.slack.com/apps → **Create New App** → From scratch.
3. **OAuth & Permissions → Bot Token Scopes:** `chat:write`, `pins:write`, `canvases:write`, `channels:read` (add `groups:read` if the channel is private).
4. **Install to Workspace**, copy the **Bot User OAuth Token** (`xoxb-…`).
5. In the channel: `/invite @YourAppName`.
6. Channel ID: open the channel details → bottom of the About tab (starts with `C`).

### 2. Bell GIF
Upload your bell GIF to Shopify **Content → Files**, copy the `cdn.shopify.com` URL, and paste it into `BELL_GIF_URL` in `wrangler.toml`. Any public `.gif` URL works.

### 3. Deploy the worker
```bash
npm install
npx wrangler login
npx wrangler d1 create order-bell          # paste the database_id into wrangler.toml
npm run db:init                            # creates tables
# edit the [vars] in wrangler.toml (store domain, channel ID, gif URL, timezone)
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET   # from step 4
npx wrangler secret put ADMIN_KEY                # any long random string
npm run deploy                                   # note the https://…workers.dev URL
```

### 4. Shopify webhook
Shopify admin → **Settings → Notifications → Webhooks → Create webhook**
- Event: **Order creation**, Format: **JSON**
- URL: `https://<your-worker>.workers.dev/webhooks/shopify/orders-create`
- The signing key shown at the bottom of that Webhooks page is your `SHOPIFY_WEBHOOK_SECRET`.
(If you register the webhook through a Shopify app instead, the secret is that app's client secret.)

### 5. Test
```bash
curl -X POST https://<your-worker>.workers.dev/admin/test -H "x-admin-key: <ADMIN_KEY>"
```
Posts a `[TEST]` order built from the `smitten-with-the-small-stuff` example link and creates the canvas tab. Test orders are never counted in totals. Then place a real order through a UTM'd link and check it end-to-end.

`POST /admin/refresh` (same header) rebuilds the canvas on demand.

## Optional: better attribution
By default the worker reads `landing_site` / `referring_site` from the order webhook. For more reliable UTMs, give it an Admin API token with `read_orders` scope:
```bash
npx wrangler secret put SHOPIFY_ADMIN_TOKEN
```
It will then pull Shopify's customer journey (the converting visit's landing page + parsed UTMs), retrying for a few seconds since that data can lag the webhook. Set `ATTRIBUTION = "first"` to use first-touch instead of last-touch.

## Config reference (`wrangler.toml` [vars])
| Var | Purpose |
|---|---|
| `SHOPIFY_STORE` | `your-store.myshopify.com` — admin links + GraphQL |
| `STOREFRONT_DOMAIN` | `drinkbrightside.com` — builds full URLs from Shopify's relative landing paths |
| `SLACK_CHANNEL_ID` | Channel to post to |
| `BELL_GIF_URL` | Public GIF URL (blank = no image) |
| `STORE_TIMEZONE` | Drives MTD/WTD boundaries |
| `WEEK_START` | `1` Monday, `0` Sunday |
| `ONLINE_SOURCE_NAMES` | Shopify `source_name` values that count as online (default `web`, which skips POS/draft/wholesale). Add others if needed, comma-separated |
| `DASHBOARD_MODE` | `canvas` = channel canvas tab (default); `message` = a pinned message edited in place |
| `SLACK_CANVAS_ID` | Optional override if the channel already has a canvas you want to use |

## Known limits
- **Lifetime starts at install.** Orders placed before the webhook existed aren't counted (a backfill script can be added).
- **Gross, not net.** Refunds and cancellations aren't subtracted.
- Shopify test-gateway orders (`order.test = true`) are posted with a `[TEST]` tag but not counted.
- Running both Brightside and Cantrip? Deploy a second copy with a different `name`, database, channel and webhook.

## Files
- `src/index.js` — webhook endpoint, HMAC check, order processing, optional GraphQL lookup
- `src/utm.js` — URL → Landing Page / Source / Medium / Campaign / Content / Term
- `src/slack.js` — Slack API + the bell message
- `src/dashboard.js` — Lifetime/MTD/WTD math and the canvas/pinned-message rendering
- `schema.sql`, `wrangler.toml`, `test/utm.test.js` (`npm test`)
