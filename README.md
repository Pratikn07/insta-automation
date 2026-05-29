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

Register the ngrok URL in Meta Developer Dashboard → Webhooks, subscribe to `comments` and `messages` fields, then comment a configured keyword on your test reel.

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

See `/Users/pratik.nandoskar/.claude/plans/tell-me-all-the-concurrent-hamming.md` for the full plan.
