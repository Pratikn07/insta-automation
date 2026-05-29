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

## Troubleshooting

| Symptom | Fix |
|---|---|
| `CORS blocked` on Vercel calling Railway | `WEB_ORIGIN` doesn't include the Vercel URL exactly. Paste it again, no trailing slash. |
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
