# Owner-Approved DM Drafts and Engagement Follow-Ups

## Goal

Tiny SOHO reads Instagram DM context and prepares useful replies for the owner. It may also prepare one proactive engagement follow-up after a person successfully receives a guide. No AI-generated message is sent automatically: Instagram delivery happens only after the authenticated owner reviews the exact visible text and clicks **Approve & Send**.

## Scope

This design covers two draft types that share one generation and approval pipeline:

1. `reply`: a response to an inbound DM that was not fully handled by an existing keyword or guide flow.
2. `engagement_follow_up`: a short check-in scheduled after successful guide delivery.

Existing keyword, follow-gate, and guide-delivery automations continue unchanged. The persistent business advisor is outside this design.

## Non-goals

- Codex never sends an Instagram message directly.
- No AI-generated message is sent by a background worker.
- No follow-up is scheduled for a failed or incomplete guide delivery.
- No Human Agent tag or seven-day support exception is used for engagement follow-ups.
- No follow-up is sent outside Meta's standard 24-hour messaging window.
- No bulk follow-up campaign, notification system, or automatic optimization is introduced.

## Hard approval boundary

The Codex runtime has no Instagram, database, Supabase, or Tiny SOHO owner credentials. Its drafting thread has no tools, uses a read-only sandbox, and can only return validated structured text.

Tiny SOHO's API remains the sole Instagram credential boundary. A generated draft can reach the existing Instagram send function only when all of these conditions hold:

- The request comes from the existing authenticated Tiny SOHO owner.
- `AI_SEND_ENABLED=true`.
- The draft is in `pending_approval` state.
- Its prompt-policy version is current.
- It still belongs to the latest genuine inbound message.
- For a follow-up, its eligibility time has arrived and its deadline has not passed.
- A short database transaction atomically claims the draft for sending.

The **Approve & Send** button sends immediately without a second confirmation dialog. The text visible in the editor at the instant of approval is copied to `approvedText` and is the exact text passed to Instagram.

No worker calls the AI-approved send path. Definite send failures may be retried only through another explicit owner request. Ambiguous timeouts remain `send_uncertain`, require the owner to check Instagram, and are never retried automatically.

## Reactive reply lifecycle

1. Tiny SOHO records an inbound Instagram DM idempotently using Meta's message ID.
2. Existing keyword and guide logic runs first.
3. If that logic does not fully handle the message, Tiny SOHO queues a `reply` draft for the latest inbound message.
4. The draft worker asks the isolated Codex runtime for one structured suggestion.
5. A valid suggestion becomes `pending_approval`; invalid or failed generation becomes `generation_failed`.
6. The owner may edit, regenerate, dismiss, or click **Approve & Send**.
7. A newer genuine inbound message supersedes the older draft.

Inbound ordering uses `(instagramTimestamp, instagramMessageId)` rather than webhook arrival order. A delayed older webhook is stored for transcript completeness but cannot replace the latest inbound message, supersede a current draft, or change `needsReply`.

## Engagement follow-up lifecycle

1. A guide sequence completes successfully for a conversation.
2. If `AI_FOLLOW_UPS_ENABLED=true`, Tiny SOHO calculates:
   - `eligibleAt = guideDeliveredAt + 12 hours`
   - `expiresAt = latestInbound.instagramTimestamp + 23 hours 30 minutes`
3. If `eligibleAt >= expiresAt`, no follow-up is scheduled because there is not enough safe time remaining.
4. Otherwise, Tiny SOHO atomically marks that conversation as having scheduled its one engagement follow-up and creates a queued `engagement_follow_up` draft anchored to the latest inbound message.
5. The existing draft worker ignores the queued item until `eligibleAt`, then generates the follow-up.
6. The owner sees the generated follow-up, its rationale and warnings, and an exact **Send by** deadline.
7. The owner may edit, regenerate, dismiss, or click **Approve & Send**.
8. A newer genuine inbound message supersedes the follow-up. The new message proceeds through the normal reactive flow.
9. At or after `expiresAt`, an unsent follow-up becomes `expired`. Expired follow-ups remain visible for audit history but cannot be regenerated, approved, or sent.

Each successful guide-delivery conversation can schedule at most one engagement follow-up. Regenerating that follow-up creates a new draft revision within the same scheduled follow-up lifecycle; it does not create a second follow-up opportunity.

## Data model

Add the following enum:

```text
ReplyDraftKind
  reply
  engagement_follow_up
```

Extend `ReplyDraft` with:

```text
kind                 ReplyDraftKind  default reply
sourceConversationId UUID?           guide-delivery conversation for a follow-up
eligibleAt           DateTime        default now
expiresAt            DateTime?       required for engagement_follow_up
promptVersion        Int?            null means legacy and cannot be approved
```

Add `expired` to `ReplyDraftStatus`.

Extend `Conversation` with:

```text
engagementFollowUpScheduledAt DateTime?
```

The migration adds a database check requiring `sourceConversationId` and `expiresAt` whenever `kind = engagement_follow_up`. Application validation alone is not sufficient for a deadline that protects an external platform-policy boundary.

Scheduling performs a conditional update where `engagementFollowUpScheduledAt IS NULL` and creates the queued draft in the same database transaction. A replay therefore converges on the existing lifecycle instead of producing another follow-up.

The existing one-active-draft-per-thread partial unique index remains the final collision guard. Draft creation must not query for a winner inside a PostgreSQL transaction that has already failed with a uniqueness violation. A collision retries the complete transaction or performs the winner lookup after rollback.

`nextAttemptAt` remains the worker's due-time index and is set to `eligibleAt`. The explicit `eligibleAt` field remains owner-facing business state, while `nextAttemptAt` may also move for bounded generation retry behavior in future versions. This milestone performs no automatic generation retry.

## Codex inputs and output

The draft request adds the draft `kind`, guide-delivery time when applicable, and the fixed follow-up purpose. Codex receives only:

- The newest 20 messages, returned oldest-to-newest within that bounded window.
- Participant name or username when available.
- The relevant guide name and description.
- Guide-delivery time for an engagement follow-up.
- The configured brand voice.

The DM transcript is supplied as untrusted context. The runtime starts the pinned Codex thread using the protocol field `developerInstructions`; the incorrect `developerMessage` field is removed.

The structured result remains:

```ts
interface DmDraftSuggestion {
  reply: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  warnings: string[];
  modelId: string | null;
}
```

The current prompt-policy version is a code constant shared by generation and approval. Generation writes that value to `ReplyDraft.promptVersion`. Approval rejects null, older, or unknown versions.

## Follow-up writing rules

An engagement follow-up:

- Is one or two short sentences.
- Naturally references the guide or its topic.
- Asks one useful, easy-to-answer question.
- Seeks a genuine conversation rather than another sale.
- Does not repeat the resource link unless the conversation requires it.
- Does not ask for another follow.
- Does not manufacture urgency, guilt, or pressure.
- Does not diagnose a medical, developmental, or psychological condition.
- Does not claim or imply that it was sent.
- Returns only the required structured result.

The ordinary reply prompt retains the same prompt-injection, medical-boundary, brand-voice, and approval rules.

## Conversations interface

The Conversations tab distinguishes these states in plain language:

- **Follow-up scheduled** — shows when drafting becomes eligible.
- **Writing follow-up** — generation is in progress.
- **Follow-up ready** — shows editable text, rationale, warnings, confidence, and the local **Send by** time.
- **Follow-up expired** — remains visible but has no send or regenerate action.
- **Follow-up cancelled** — a newer message replaced the scheduled follow-up.

Both reply types reuse the existing editor and revision history. A ready draft offers edit, **Try another**, **Dismiss**, and **Approve & Send**. Sending-disabled environments clearly state that sending is unavailable; they do not imply that approval succeeded.

If the deadline passes while the page is open, the API returns a stable `follow_up_window_closed` conflict. The client invalidates the thread query and renders the draft as expired.

The thread detail endpoint returns the newest 200 messages and reverses them for chronological display. It never shows the oldest 200 while omitting the current approval context.

## Error handling and recovery

- **Codex disconnected:** leave the item queued or show a safe generation failure; never send.
- **Codex quota reached:** show the safe retry time when available; never infer zero usage.
- **Codex child exits:** the runtime becomes unhealthy and exits nonzero so Railway restarts it.
- **Invalid model output:** mark `generation_failed`; partial text is never approvable.
- **New inbound before approval:** mark the follow-up `superseded` and refuse approval.
- **Deadline reached:** mark the follow-up `expired` and refuse generation, regeneration, approval, and retry.
- **Definite Instagram rejection:** mark `send_failed`; owner retry remains possible only before the deadline.
- **Ambiguous Instagram result:** mark `send_uncertain`; require owner confirmation after checking Instagram and before the deadline.
- **Process crash while `sending`:** reconcile stale `sending` rows to `send_uncertain`; never retry them automatically.

All state-changing API handlers return controlled errors rather than leaving rejected async operations outside Express error handling.

## Privacy and logging

Full DM bodies live only in `DmMessage`, and generated/edited/approved text lives only in the corresponding `ReplyDraft` fields. General `EventLog` records IDs, state changes, lengths, timestamps, draft kind, prompt version, and the authenticated owner identity—not message bodies.

Application logs do not emit DM text, prompt text, model output, ChatGPT credentials, runtime bearer tokens, or raw app-server errors. Runtime and API responses continue to expose only stable error codes.

## Feature flags

- `AI_DRAFTS_ENABLED` controls the shared generation worker.
- `AI_FOLLOW_UPS_ENABLED` controls proactive follow-up scheduling independently from ordinary replies.
- `AI_SEND_ENABLED` controls only owner-approved AI delivery and retry endpoints.
- `AI_ADVISOR_ENABLED` remains independent and is outside this design.

No boolean flag accepts arbitrary non-empty strings as true; invalid configured values fail startup.

## Migration of existing drafts

All drafts created before the corrected developer instructions have `promptVersion = null`. During deployment, existing unsent drafts in `queued`, `generating`, `pending_approval`, or `generation_failed` become `superseded`. They remain available for audit history but cannot be sent. Fresh drafts use the current prompt version.

Any legacy `send_failed` or `send_uncertain` row retains its audit status, but the retry claim rejects it because its prompt version is missing. This matters even if production has never enabled AI sending: the invariant does not depend on that deployment assumption.

`AI_SEND_ENABLED` remains false during this migration and throughout shadow verification.

## Test strategy

### Unit and contract tests

- The pinned Codex binary receives `developerInstructions`, not `developerMessage`.
- Both draft kinds produce the correct bounded, newest-message context.
- Follow-up scheduling calculates the 12-hour eligibility and 23-hour-30-minute deadline correctly.
- Insufficient remaining time skips scheduling.
- Prompt-version enforcement rejects every legacy or mismatched draft.
- Out-of-order webhooks are stored without replacing newer inbound state.
- Duplicate delivery events create one follow-up lifecycle.
- Concurrent draft creation converges after transaction rollback.
- Deadline and latest-inbound checks occur in the atomic approval claim.
- Background workers have no reachable Instagram send call.

### API and interface tests

- Owner authentication is required for edit, regenerate, dismiss, approve, and retry.
- `AI_SEND_ENABLED=false` returns `ai_send_disabled` without calling Instagram.
- **Approve & Send** delivers the exact edited text once.
- Duplicate approvals cannot double-send.
- Retry refuses legacy `send_failed` and `send_uncertain` drafts with a missing or outdated prompt version.
- Scheduled, writing, ready, expired, cancelled, definite-failure, and uncertain states render correctly.
- A deadline expiring while the editor is open refreshes to expired.
- The thread detail shows the newest 200 messages.

### Production acceptance

1. Deploy the Codex runtime safety fixes.
2. Deploy the database migration and API changes with `AI_SEND_ENABLED=false` and `AI_FOLLOW_UPS_ENABLED=false`.
3. Deploy the Conversations interface.
4. Verify legacy unsent drafts are not approvable.
5. Generate and inspect ordinary shadow drafts.
6. Enable `AI_FOLLOW_UPS_ENABLED` and inspect scheduled and generated shadow follow-ups.
7. Verify a new inbound cancels its scheduled follow-up and a late approval is refused.
8. Verify existing keyword and guide automations are unchanged.
9. Enable `AI_SEND_ENABLED` last.
10. Edit one test draft, click **Approve & Send**, and verify the exact text is delivered once and recorded once.

## Acceptance criteria

- Eligible unhandled DMs produce useful owner-reviewable reply drafts.
- A successful guide delivery schedules at most one follow-up for 12 hours later when sufficient Meta-window time remains.
- Every AI-generated send requires a current authenticated owner click on **Approve & Send**.
- No worker, Codex process, retry loop, or schedule can send an AI-generated message.
- The exact approved text is the only AI-generated content passed to Instagram.
- Newer messages, expired windows, legacy prompts, duplicate approvals, and duplicate webhooks fail safely.
- Existing Instagram keyword and guide behavior remains unchanged.

## Reference

- [Meta Instagram API messaging documentation](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-20fd4e9e-0040-4e03-9100-c69ec09dbe67) — standard 24-hour messaging window and Human Agent limitations.
