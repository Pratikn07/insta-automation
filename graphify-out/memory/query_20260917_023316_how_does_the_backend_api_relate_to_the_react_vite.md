---
type: "query"
date: "2026-09-17T02:33:16.028058+00:00"
question: "How does the backend API relate to the React/Vite frontend?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["src/server.ts", "router.ts", "apiRead()"]
---

# Q: How does the backend API relate to the React/Vite frontend?

## Answer

Expanded graph vocabulary: api, react, vite, frontend, route, server. src/server.ts imports src/api/router.ts; web/src/lib/api.ts apiRead() is imported by React pages and components.

## Outcome

- Signal: useful

## Source Nodes

- src/server.ts
- router.ts
- apiRead()