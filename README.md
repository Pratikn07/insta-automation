# insta-automation

Personal Instagram comment-to-DM automation for `@tinysoho`.

**Flow:** user comments a keyword on a reel → bot replies publicly + DMs the gate message → user follows and replies `DONE` → bot delivers a configured sequence (text / image / PDF).

## Stack

- Node.js + Express (TypeScript)
- Supabase Postgres (data) + Supabase Storage (assets) + Supabase Table Editor (admin UI)
- Prisma ORM
- Meta Graph API (Instagram Messaging + Comments + Webhooks)
- Hosted on Railway, tunneled with ngrok in local dev

## Quickstart

```bash
cp .env.example .env       # fill in the values
npm install
npx prisma migrate dev     # create tables in Supabase
npm run dev                # start server on :3000
ngrok http 3000            # expose to Meta webhook
```

Register the ngrok URL in Meta Developer Dashboard → Webhooks, subscribe to the
`comments`, `messages`, `messaging_seen`, `message_reactions`, and
`messaging_postbacks` fields, then comment a configured keyword on your test reel.

The last three carry read and engagement evidence for DM recovery. Without them
the system never learns that anyone opened a gate DM — and because absence of a
receipt means **No confirmed read**, never `Unread`, the recovery worker would
treat healthy journeys as unread ones. Do not enable
`DM_RECOVERY_ENABLED=true` until they are subscribed and a real signal has been
observed; see [docs/meta-verification.md](docs/meta-verification.md) for the
launch runbook.

## DM recovery timing experiment

The current prospective experiment compares public recovery comments sent two
hours after gate-DM acceptance, sent six hours after acceptance, or intentionally
withheld. Followers are assigned deterministically in a fixed 45% / 45% / 10%
split under version `read-recovery-timing-v2`.

The Recovery dashboard uses guide-request dates (`7d`, `14d`, `30d`, `All`, or a
custom range), not campaign names. It reports immature 48-hour outcomes
separately and never declares a winner from a partial range. There is no
automatic rollout.

Code deployment does not authorize activation. Keep the safe v1 configuration
until the schema, real-Postgres contracts, Meta signals, and owner checklist are
complete. Follow the
[DM recovery timing experiment runbook](docs/dm-recovery-timing-experiment-runbook.md)
for cutover, monitoring, analysis, and rollback.

## Layout

```
src/
├── server.ts             entry
├── config/env.ts         typed env loader
├── meta/                 Graph API wrappers
├── handlers/             webhook event handlers
├── services/             business logic
├── lib/                  prisma + supabase + logger
└── types/                Meta payload types
prisma/schema.prisma      DB schema
scripts/seed-keywords.ts  seed initial keywords
```

Detailed operational documentation lives in [`docs/`](docs/).
