---
type: "query"
date: "2026-09-17T02:33:15.779885+00:00"
question: "What files are involved in Instagram automation?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["handleMessage()", "webhookRouter.ts"]
---

# Q: What files are involved in Instagram automation?

## Answer

Expanded graph vocabulary: instagram, comment, message, handler, guide, delivery. webhookRouter.ts imports and calls handleMessage() in src/handlers/messageHandler.ts; that handler connects journey, guide-delivery, inbound-message, and reply-draft work.

## Outcome

- Signal: useful

## Source Nodes

- handleMessage()
- webhookRouter.ts