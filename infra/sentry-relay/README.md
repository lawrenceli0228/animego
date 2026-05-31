# Sentry relay (task #13)

The prod VPS (HK) can't reach `sentry.io` — server-side Sentry events from
`go-api` never send. This Cloudflare Worker relays them through CF's edge,
which can reach sentry.io. `go-api` needs no code change; only its
`SENTRY_DSN` **host** is swapped to the relay domain.

```
go-api  →  sentry-relay.animegoclub.com (CF Worker)  →  o4511…ingest.us.sentry.io
```

## Deploy (Cloudflare dashboard, ~5 min)

1. **Workers & Pages → Create → Worker.** Name it `sentry-relay`.
2. Paste `worker.js` from this directory. Save & Deploy.
3. **Settings → Domains & Routes → Add → Custom Domain:**
   `sentry-relay.animegoclub.com`
   (CF auto-creates the DNS + cert since the zone is already on CF.)
4. *(Recommended)* **Security → WAF → Rate limiting rule** on that hostname,
   e.g. 120 req/min, to cap quota abuse if the relay URL is discovered.

Or via wrangler:

```bash
cd infra/sentry-relay
npx wrangler deploy worker.js --name sentry-relay
npx wrangler deployments domains add sentry-relay.animegoclub.com
```

## After it's live — the go-api side (orchestrator does this)

Swap the DSN **host** only (keep the key + project id):

```
# before
SENTRY_DSN=https://<key>@o4511456470368256.ingest.us.sentry.io/4511456471875584
# after
SENTRY_DSN=https://<key>@sentry-relay.animegoclub.com/4511456471875584
```

Then `docker compose --env-file .env.production up -d --force-recreate go-api`
and trigger a test error to confirm it lands in Sentry.

## Notes

- Only `POST /api/4511456471875584/envelope/` is forwarded; anything else 404s,
  so it isn't a generic open proxy.
- The public key in the DSN is already exposed (client bundles), so the relay
  leaks no new secret. The project-id filter + CF rate limit cap abuse.
- Free tier (100k req/day) is far above error volume.
