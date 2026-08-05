# codex-runtime

A private Railway service that holds the owner's ChatGPT sign-in and runs Codex
`app-server` on their behalf. Nothing else in Tiny SOHO ever touches those
credentials.

**No OpenAI API key is used anywhere.** The owner links their own ChatGPT
subscription with a device code, so drafting and advisor answers come out of a
plan they already pay for. `OPENAI_API_KEY` is deliberately not read; a test
asserts it is ignored even when present in the environment.

## What it can and cannot do

It can draft a DM reply and answer read-only questions about the business. It has
**no** Instagram credentials, **no** database access, and no send primitive —
`rg -n 'sendTracked|sendTextMessage|sendMedia' codex-runtime/src` returns nothing,
and a test asserts the advisor's three tools contain none of
`send|write|update|delete|instagram`.

Everything that reaches a real person goes through the owner's explicit approval
in the main API, never from here.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /health` | Railway probe. Public. Reports `appServerReady`. |
| `GET /internal/account/status` | ChatGPT connection, plan and quota. |
| `POST /internal/account/login/start` | Begin device-code linking. |
| `POST /internal/account/logout` | Delete the stored sign-in. |
| `POST /internal/drafts/generate` | One DM draft. Ephemeral thread, no tools. |
| `GET /internal/advisor/history` | The owner's advisor conversation. |
| `POST /internal/advisor/messages` | Ask one advisor question. |

Every `/internal` route requires `Authorization: Bearer $RUNTIME_SHARED_SECRET`
and is compared in constant time. No app-server error text is ever forwarded — a
raw message can embed account or token detail, so callers get a stable code and a
nullable `retryAt`.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | Defaults to 3001. Railway sets it. |
| `NODE_ENV` | no | `production` on Railway. |
| `CODEX_HOME` | yes | Must be on the persistent volume, e.g. `/data/codex`. Holds the ChatGPT sign-in and the advisor thread pointer. |
| `CODEX_WORKSPACE` | yes | Scratch cwd for app-server. Nothing valuable lives here. |
| `RUNTIME_SHARED_SECRET` | yes | ≥32 chars. The bearer the API presents to this service. |
| `TINY_SOHO_API_URL` | no | Private URL of the API, for the advisor's three read tools. |
| `TINY_SOHO_INTERNAL_TOKEN` | no | The bearer this service presents back to the API. Must match the API's value of the same name. |

The last two are optional on purpose: without them DM drafting still works (it is
tool-free) and only the advisor reports itself unavailable. Speculating without
evidence is worse than saying so.

## Persistence

`CODEX_HOME` must be a mounted volume, or the owner has to re-link ChatGPT after
every deploy. Two things live there:

- the Codex sign-in, written by `app-server`;
- `tinysoho-advisor-session.json` — a single `{ schemaVersion, threadId, updatedAt }`
  document, mode `0600`, written temp-then-rename. It holds **no** message content
  and **no** credentials. A malformed file starts a fresh thread and is left on
  disk rather than deleted, so app-server history stays intact and the file is
  still inspectable.

## Railway setup

1. New service in the existing project, named `codex-runtime`.
2. **Root directory** `/codex-runtime`, **build** `npm run build`, **start** `npm start`.
3. Add a persistent volume mounted at `/data`, then set `CODEX_HOME=/data/codex`.
4. Set the variables above. Use Railway private DNS for `TINY_SOHO_API_URL`
   (e.g. `http://tiny-soho-api.railway.internal:3000`) so advisor traffic never
   leaves the private network.
5. Do **not** expose a public domain. Only the API needs to reach it.

## Verify a deploy

```sh
curl -s https://<runtime>/health
# {"ok":true,"appServerReady":true}
```

Then open `/assistant` in the web app and click **Connect ChatGPT**. Enter the
short code at the URL shown. The card polls and flips to connected on its own; it
also reports the plan and remaining quota, which is the fastest confirmation that
app-server is genuinely talking to OpenAI.

`appServerReady: false` means the child process is not up — the service starts
app-server *before* it listens, so a healthy-but-not-ready runtime means it died
after boot. Check `railway logs`; startup errors are logged by message only, never
with the raw error, because that can embed account detail.

## Local development

```sh
cp .env.example .env
npm install
npm run dev
```

```sh
npm test        # 110 tests
npm run build
```
