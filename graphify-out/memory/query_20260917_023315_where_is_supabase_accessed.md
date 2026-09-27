---
type: "query"
date: "2026-09-17T02:33:15.900969+00:00"
question: "Where is Supabase accessed?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["supabase", "prisma"]
---

# Q: Where is Supabase accessed?

## Answer

Expanded graph vocabulary: supabase, prisma, storage. Graph identifies src/lib/supabase.ts for API upload/auth access and web/src/lib/supabase.ts for frontend api.ts, Login.tsx, and useAuth.ts access.

## Outcome

- Signal: useful

## Source Nodes

- supabase
- prisma