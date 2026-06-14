# Cloudflare Worker — live results API

Replaces `make sync` with a serverless endpoint. The page fetches live data on
every load instead of reading the static `data/results.js`.

## What it does

- One endpoint, any path: `GET https://<your-worker>.workers.dev/`
- On each request: hits football-data.org, runs the same scoring logic as
  `sync.py`, returns the same JSON shape as `data/results.json`
- Cached at the Cloudflare edge for 60 seconds — a viral refresh doesn't blow
  through football-data.org's 10 req/min ceiling
- API key stored as a Worker secret, never exposed to the page

## One-time setup

### 1. Cloudflare account + Wrangler

Sign up free at <https://dash.cloudflare.com/sign-up>. No credit card needed
for the free Workers tier (100k requests/day, way more than this league needs).

Then from this `worker/` directory:

```sh
npm install
npx wrangler login   # opens browser, asks you to authorize the CLI
```

### 2. Add your football-data.org key as a Worker secret

```sh
npx wrangler secret put FOOTBALL_DATA_API_KEY
# paste your key when prompted; it's stored encrypted in Cloudflare
```

### 3. Deploy

```sh
npm run deploy
```

Output prints the live URL, e.g. `https://wc-draft-order.<account>.workers.dev`.
Curl it to confirm:

```sh
curl https://wc-draft-order.<account>.workers.dev | head -40
```

### 4. Point the page at the Worker

Edit `../config.js` and paste the URL into `workerUrl`. Commit + push:

```sh
git add config.js
git commit -m "config: point page at Cloudflare Worker"
git push
```

GitHub Pages picks up the new commit in ~30s. From now on the page shows live
data on every refresh; the "Last synced" line changes to "Live · fetched ...".

## When to re-deploy

The Worker bundles `data/managers.json`, `data/teams.json`, and
`data/scoring.json` at deploy time. So:

- **After the draw, when you edit managers.json** → re-deploy
- **If you fix an apiName in teams.json** → re-deploy
- **If you tweak scoring rules** → re-deploy
- Match data is NOT bundled (fetched live every request) — no re-deploy needed
  during the tournament

```sh
cd worker/ && npm run deploy
```

## Local development

```sh
npm run dev   # runs the Worker locally at http://localhost:8787
```

`wrangler dev` will prompt for the API key on first run; pick "Use a local
secret" and paste your key (stored in `.dev.vars`, gitignored).

## Tail logs

```sh
npm run tail
```

Streams `console.log` and errors from the live Worker.

## Costs

- Cloudflare Workers free tier: 100,000 requests/day, 10ms CPU per invocation
- Each page load = 1 Worker request, often cache-served (free, doesn't count)
- football-data.org free tier: 10 req/min — Worker's 60s edge cache keeps us
  well under
- Bandwidth: free (Cloudflare doesn't charge for outbound)

Realistically, $0/month for this league.

## Troubleshooting

| Problem | Fix |
|---|---|
| `wrangler login` opens a 404 page | Try `npx wrangler login --browser=false` and follow the URL it prints |
| Deploy fails with "no compatibility_date" | Update `wrangler.toml` `compatibility_date` to today's date |
| `curl <worker-url>` returns 500 with "FOOTBALL_DATA_API_KEY secret is not configured" | Re-run `npx wrangler secret put FOOTBALL_DATA_API_KEY` |
| `curl <worker-url>` returns 502 from football-data.org | Hit their rate limit, or your API key is invalid. Check `npx wrangler tail` |
| Page still shows "Last manual sync" instead of "Live" | Check that `config.js` has the correct `workerUrl` and that you committed/pushed it |
| Browser dev tools show a CORS error | The Worker sets `access-control-allow-origin: *`, but verify the request actually reached the Worker (Network tab); CORS only blocks responses, so a network-level failure isn't really CORS |

## Removing it later

If you ever want to go back to fully static:

1. Clear `workerUrl` in `config.js` (set to empty string)
2. Commit + push
3. Optional: `npx wrangler delete` to tear down the Worker
