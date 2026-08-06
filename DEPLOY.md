# Deploy guide — Tiny Soho admin

End-to-end deploy: backend → Railway, frontend → Vercel. Two CLIs, ~20 minutes start to finish.

---

## Prereqs

```sh
npm i -g @railway/cli vercel
```

You'll need:
- Your existing **Supabase project** (URL, anon publishable key, service key, JWT secret)
- Your existing **Meta** app secret + IG access token + IG user ID
- Your wife's **Gmail** (the ADMIN_EMAIL allowlist)
- A **Railway** account (free tier fine; bot uses pennies)
- A **Vercel** account (free Hobby plan)

---

## 1. Deploy backend to Railway

From the project root (`mch/insta-automation/`):

```sh
railway login
railway init                    # create new project, name it "insta-automation"
railway link                    # if you already created one in the dashboard
```

### Add a Postgres? **No** — we use Supabase. Skip Railway's database addon.

### Set env vars (paste from your local `.env`):

```sh
railway variables \
  --set NODE_ENV=production \
  --set LOG_LEVEL=info \
  --set META_APP_SECRET=... \
  --set META_VERIFY_TOKEN=... \
  --set IG_ACCESS_TOKEN=... \
  --set IG_USER_ID=... \
  --set DATABASE_URL='postgresql://...supabase.co:5432/postgres?...' \
  --set SUPABASE_URL=https://kukpvpklizsvedcmybhn.supabase.co \
  --set SUPABASE_SERVICE_KEY=... \
  --set SUPABASE_BUCKET=insta-resources \
  --set ADMIN_EMAIL=her@gmail.com \
  --set WEB_ORIGIN=https://placeholder.vercel.app
```

`WEB_ORIGIN` will be updated in step 3 once Vercel gives you the real URL.

### Deploy:

```sh
railway up
```

First build: ~2 min. `prisma generate` runs in `postinstall`; `prisma migrate deploy` runs at start. No manual DB step.

### Get the public URL:

```sh
railway domain                  # creates a *.up.railway.app domain if none
```

Save this. You'll need it for `VITE_API_URL` and the Meta webhook callback.

### Smoke test:

```sh
curl https://YOUR.up.railway.app/health
# {"ok":true,"env":"production"}
```

---

## 2. Update Meta webhook callback

Meta App Dashboard → Instagram → Webhooks → Callback URL:
- Old: `https://your-ngrok-or-local.example.com/webhook`
- New: `https://YOUR.up.railway.app/webhook`

Verify token stays the same (`META_VERIFY_TOKEN`). Click "Verify and Save".

---

## 3. Deploy frontend to Vercel

```sh
cd web
vercel login
vercel                          # first deploy: answer prompts
                                # - Set up and deploy? Y
                                # - Scope: your account
                                # - Link to existing? N
                                # - Project name: tiny-soho-admin
                                # - Directory: ./
                                # - Override settings? N (Vite is auto-detected)
```

This creates a preview deploy. Note the URL it prints.

### Set env vars:

```sh
vercel env add VITE_SUPABASE_URL production
# paste: https://kukpvpklizsvedcmybhn.supabase.co

vercel env add VITE_SUPABASE_ANON_KEY production
# paste: sb_publishable_cVwOAgtDTfl6hn7wNz-Lnw_Sjcj5N0p

vercel env add VITE_API_URL production
# paste: https://YOUR.up.railway.app
```

### Promote to production:

```sh
vercel --prod
```

Save the production URL Vercel prints (e.g. `https://tiny-soho-admin.vercel.app`).

---

## 4. Wire up the cross-service URLs

### Railway: allow Vercel's domain in CORS

```sh
railway variables --set WEB_ORIGIN=https://tiny-soho-admin.vercel.app
```

Railway redeploys on var change. Wait ~30s.

You can pass multiple comma-separated origins if you want preview deploys to work:
```
WEB_ORIGIN=https://tiny-soho-admin.vercel.app,http://localhost:5173
```

### Supabase: allow Vercel as a magic-link redirect

Supabase Dashboard → Authentication → URL Configuration → **Redirect URLs**:
- Add: `https://tiny-soho-admin.vercel.app/**`
- Keep: `http://localhost:5173/**` (for local dev)

Save.

---

## 5. Smoke test

1. Open `https://tiny-soho-admin.vercel.app` on phone or laptop
2. Magic-link login with `ADMIN_EMAIL` → click link in inbox → land on Home
3. Stat cards load (means JWT verified, Railway is reachable, CORS works)
4. Click Keywords → list loads
5. Try logging in with a non-allowlisted email → should be rejected

If any step fails, see Troubleshooting below.

---

## 6. Live test (optional, once ready)

1. From the **wife's content account**, comment a real keyword on a real reel
2. Watch Conversations page → row should appear within ~2s
3. From a **second IG account** (not yours), reply DONE to the gate DM
4. Sequence should deliver

---

## 7. AI: Codex runtime and staged rollout

Optional. If this rollout is not being performed, leave all AI flags `false` and
every existing keyword, gate and guide automation behaves exactly as before.

**No OpenAI API key is involved.** The owner links their own ChatGPT subscription
with a device code. `OPENAI_API_KEY` is never read by any service — do not add it.

### 7.1 Create the runtime service

1. New Railway service in the same project, named `codex-runtime`.
2. **Root directory** `/codex-runtime` · **build** `npm run build` · **start** `npm start`.
3. Add one persistent volume mounted at `/data`. Without it the owner must
   re-link ChatGPT after every deploy.
4. Keep exactly **one replica**. Railway services with a persistent volume cannot
   run multiple replicas.
5. Do **not** create a public domain. Only the API reaches this service over
   Railway private DNS.
6. Set the Railway healthcheck path to `/health`. The service listens on
   `[::]:3001`, which supports Railway's current dual-stack and legacy private
   networks. Railway waits for HTTP 200 during deployment; this healthcheck is
   not continuous monitoring after the deployment becomes active.

### 7.2 Runtime variables

```sh
PORT=3001
CODEX_HOME=/data/codex
CODEX_WORKSPACE=/tmp/tinysoho-codex-workspace
RUNTIME_SHARED_SECRET=<64-character secret>
```

Also set the runtime-only environment:

```sh
NODE_ENV=production
TINY_SOHO_API_URL=http://<api-service>.railway.internal:3000
TINY_SOHO_INTERNAL_TOKEN=<different 64-character secret>
```

Use Railway **private DNS** for `TINY_SOHO_API_URL` so advisor traffic never leaves
the private network. The Codex app-server itself remains an internal stdio child;
it does not listen on a second network port. See `codex-runtime/README.md` for the
full table.

### 7.3 API variables

```sh
CODEX_RUNTIME_URL=http://codex-runtime.railway.internal:3001
CODEX_RUNTIME_TOKEN=<same value as RUNTIME_SHARED_SECRET>
TINY_SOHO_INTERNAL_TOKEN=<same value as the runtime's>
AI_BRAND_VOICE=Warm, practical, concise, and supportive. Never diagnose or shame a parent.
AI_DRAFTS_ENABLED=true
AI_FOLLOW_UPS_ENABLED=false
AI_SEND_ENABLED=false
AI_ADVISOR_ENABLED=false
```

The two tokens are separate on purpose: `CODEX_RUNTIME_TOKEN` secures API → runtime,
`TINY_SOHO_INTERNAL_TOKEN` secures runtime → API. Each rotates independently.

If `TINY_SOHO_INTERNAL_TOKEN` is unset on the API, `/internal/ai` fails closed with
503 rather than serving unauthenticated.

These are the initial shadow settings. `AI_SEND_ENABLED` stays `false` for this
entire checklist. Vercel environment changes affect only new deployments, so any
Vercel variable change must be followed by a new deployment or redeployment.

### 7.4 Private health verification

There is intentionally no public runtime URL to curl. During deployment, Railway
uses `/health` and waits for HTTP 200. After deployment, run the following from a
shell in the API service on the same Railway private network:

```sh
curl -fsS http://codex-runtime.railway.internal:3001/health
# {"ok":true,"appServerReady":true}
```

Also inspect the Railway deployment status and logs. A successful deployment
healthcheck proves readiness during deployment only; it does not mean Railway is
continuously probing `/health` afterward.

### 7.5 Owner-approved shadow checklist

Run the rollout in this exact order:

1. Deploy codex-runtime first; existing drafts may fail closed until the API deploy.
2. Deploy API with AI_SEND_ENABLED=false and AI_FOLLOW_UPS_ENABLED=false.
3. Confirm the migration superseded every legacy unapproved draft.
4. Deploy the Vercel interface and verify capabilities show sending disabled.
5. Inspect ordinary shadow drafts for prompt safety and context correctness.
6. Set AI_FOLLOW_UPS_ENABLED=true; keep AI_SEND_ENABLED=false.
7. Deliver a test guide and verify one follow-up appears after the controlled test clock/job run.
8. Verify new inbound cancellation, duplicate delivery dedupe, and deadline expiry.
9. Restart codex-runtime and verify account persistence plus healthy app-server recovery.
10. Stop for owner approval before setting AI_SEND_ENABLED=true.

The implementation task is complete at step 10. Enabling production sending and
delivering the first real AI-approved DM are separate owner-authorized actions.
Do not combine them with this deployment or shadow-verification checklist.

### 7.6 Production-send activation (separate authorization)

Do not perform this section during the initial rollout. Only after the owner has
reviewed the shadow results and separately authorized sending may the API be
redeployed with `AI_SEND_ENABLED=true`. The first real AI-approved DM is another
explicit owner action: review the exact visible text and click **Approve & Send**.
No worker, schedule, retry loop, or Codex process may substitute for that click.

### 7.7 Rollback

Set `AI_DRAFTS_ENABLED=false`, `AI_FOLLOW_UPS_ENABLED=false`,
`AI_SEND_ENABLED=false`, and `AI_ADVISOR_ENABLED=false`, then redeploy the API.
This stops the AI surfaces without changing existing keyword and guide delivery.

**Do not** drop the DM tables and **do not** delete the Codex volume. The tables are
the record of what was said and approved, and the volume holds the ChatGPT sign-in.
Both are recoverable only by re-doing work the owner already did.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `CORS blocked` on Vercel calling Railway | `WEB_ORIGIN` doesn't include the Vercel URL exactly. Paste it again, no trailing slash. |
| Local `npm run build` in `web/` emits a suspiciously small bundle | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are unset. `src/lib/supabase.ts` throws on import, everything downstream is tree-shaken, and the build still exits 0 with no app code in it. Copy `web/.env.example` to `web/.env.local`. Vercel sets these in production, so deploys are unaffected. |
| Assistant says "isn't set up on this environment yet" | `CODEX_RUNTIME_URL` or `CODEX_RUNTIME_TOKEN` missing on the API. |
| Assistant says "is not enabled yet" but ChatGPT is connected | `AI_ADVISOR_ENABLED` is still `false`. Expected until step 3 above. |
| `appServerReady: false` on the runtime | The app-server child died after boot. `railway logs` on `codex-runtime`. |
| Owner must re-link ChatGPT after each deploy | `CODEX_HOME` is not on the mounted volume. |
| Advisor answers but cites no data | `TINY_SOHO_API_URL` / `TINY_SOHO_INTERNAL_TOKEN` unset on the runtime, so it reports unavailable rather than speculating. |
| Magic link goes to localhost | Supabase Redirect URL not set; add `https://tiny-soho-admin.vercel.app/**`. |
| `invalid_token` on every API call | Supabase project URL or anon key on Vercel doesn't match Railway's `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`. They must point to the same project. |
| Webhook not firing | Meta webhook callback still points to old ngrok URL. Update in Meta App Dashboard. |
| Prisma migration error on Railway start | `DATABASE_URL` missing `?schema=public` or `?pgbouncer=true&connection_limit=1`. Check Supabase → Connection string → URI format. |
| 500s only on Vercel, fine locally | Railway deploy probably failed mid-way. `railway logs` to inspect. |

---

## Updating later

```sh
# Backend changes
git push                        # if you set up GitHub auto-deploy, otherwise:
railway up

# Frontend changes
cd web && vercel --prod
```

Both CLIs preserve env vars across deploys. You only set them once.
