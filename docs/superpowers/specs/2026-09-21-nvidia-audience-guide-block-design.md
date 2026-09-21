# NVIDIA Audience Guide Block Design

## Goal

Prevent any new guide-related outbound action for Instagram accounts classified as
`south_asian` by the approved NVIDIA classifier, regardless of whether that
classification has `high` or `low` confidence. A valid `unknown`, `other`, or
`us_western` result continues through the normal guide flow.

For a blocked account, the automation sends nothing: no public comment reply,
private opening, quick-reply follow-up, redelivery, or guide. The application
records an internal audit decision only; it must never tell a person that an
audience inference caused the result.

## Confirmed product policy

| Classification outcome | Guide policy |
| --- | --- |
| `south_asian`, `high` confidence | Block every outbound guide action. |
| `south_asian`, `low` confidence | Block every outbound guide action. |
| Valid `unknown` | Allow the normal flow. |
| Valid `other` or `us_western` | Allow the normal flow. |
| NVIDIA unavailable, malformed response, timeout, or stale identity snapshot | Defer with no outbound action and create an internal review/audit record. It is not an `unknown` result. |

The classifier remains a name/username proxy, not measured nationality, location,
ethnicity, or audience membership. A result is only a decision under this product
policy and never a fact about a person.

## Scope

The gate applies consistently before all new outbound guide paths:

- keyword comments, before the existing public acknowledgement or private gate;
- keyword DMs and an open-request confirmation before either legacy sequence send
  or ledger-backed delivery;
- strict-access V2 actions, including quick replies and postbacks; and
- explicit guide redeliveries.

It does not revoke, cancel, or alter a guide delivery that was already planned,
claimed, or sent before the decision was made. Existing Gemini-derived recovery
classification and historical-recovery campaign policy are out of scope and must
retain their current method provenance.

## Non-goals

- Do not replace Gemini reel/video analysis in this work.
- Do not infer country, ethnicity, religion, or real-world identity beyond the
  explicitly configured name/username proxy.
- Do not add a user-facing explanation, public reply, direct message, or automatic
  manual override for a blocked account.
- Do not use NVIDIA's developer/free API endpoint to serve live production traffic.
  Its successful credential probe proves connectivity only; NVIDIA describes that
  program as prototyping/development/testing access, while production needs an
  appropriate licensed or commercial serving arrangement.

## Architecture

### Separate guide-audience provenance

Create a guide-specific NVIDIA classification record rather than repurposing
`IgUser.inferredOrigin`, `originMethod`, or `audienceSegment`. Those existing
columns are shared with Gemini-based historical recovery and changing their current
method would make unrelated recovery decisions stale.

The new record is keyed by Instagram user id and an immutable hash of the normalized
`name` plus `username` snapshot. It stores only the validated enum result,
confidence, bounded evidence, provider/model/method version, input hash, and
timestamps. It does not persist prompt text, raw provider bodies, API keys, or
chain-of-thought.

When a profile name or username changes, its input hash changes and the record is no
longer current. A new classification is required before a new guide action can be
allowed or blocked.

### NVIDIA classifier boundary

Add an `AudienceClassificationProvider` interface and an NVIDIA implementation.
The provider sends the bounded, JSON-serialized roster of name/username strings to
the OpenAI-compatible NVIDIA chat-completions endpoint, with:

- `NVIDIA_API_KEY` held only in backend/server configuration;
- model id initially `nvidia/nemotron-3.5-lightning-30b-a3b`;
- `temperature: 0`;
- `chat_template_kwargs.enable_thinking: false`, which is required to avoid
  reasoning text consuming or contaminating structured output;
- a fixed JSON-only prompt, 80-character per-field bound, requested-id validation,
  enum validation, evidence-length cap, timeout, and safe error categories; and
- no raw provider error body or credential in logs.

The model output must carry `origin`, `confidence`, and a short evidence phrase for
each requested id. Unrecognized ids, duplicate ids, invalid enum values, malformed
JSON, incomplete rosters, or a stale identity hash are provider failures; they never
become an allowed `unknown` answer.

### Shared authorization service

Add one `guideAudienceAuthorization` service that returns exactly one of:

- `allow` for a valid current non-South-Asian result;
- `block` for either confidence level of a valid current `south_asian` result; or
- `defer` when no trustworthy current result can be obtained.

The service owns cache lookup, identity-snapshot comparison, NVIDIA classification,
durable classification write, and a decision audit event. Callers may not interpret
provider output themselves. Both a blocked and deferred decision halt their caller
without any Meta outbound call.

### Delivery-path integration

`commentHandler` must ask the authorization service after keyword matching and
comment claim, but before `resolveJourneyIntent`, `replyToComment`, private-gate
sends, or recovery scheduling. This is what enforces the user's requirement that a
blocked person receives no public comment either.

The direct-DM and open-request branches in `messageHandler`, plus the V2 action
paths in `guideAccessActionService` and `guideActionOutcomeService`, must all route
through the same decision before any opening, follow action, durable delivery plan,
or legacy `sendSequence`. The existing legacy and ledger delivery owners remain
unchanged after an `allow` decision.

The action-token router must not send a "review", "opening", or recovery notice
after an audience `block` or `defer`; it returns a non-presentable outcome. This
prevents a quick reply from bypassing the shared policy or producing the generic
message the user rejected.

For comments that expose only a username, the decision is necessarily based on that
available identity snapshot. If the snapshot produces a valid `unknown`, the user
approved normal delivery. The system must not claim it has classified an unavailable
display name or geography.

## Durable audit and operator visibility

Add a durable guide-audience decision/audit record for every `block` and `defer`
outcome. It includes a safe action source (`comment`, `dm`, `quick_reply`,
`postback`, or `redelivery`), internal ids, decision, classification snapshot,
provider/method version, and timestamp. It excludes raw user message text and raw
NVIDIA responses.

`block` is a terminal policy decision, not an automatic retry. `defer` remains
visible for owner review and may be retried only through an explicit internal
workflow after the provider or identity problem is resolved. The existing outbound
ledger remains authoritative for already-started deliveries.

## Configuration and operational controls

Add server-only configuration for:

- `NVIDIA_API_KEY` (already securely stored in Railway's `api` production service);
- `NVIDIA_AUDIENCE_MODEL`, defaulting to the tested Nemotron model;
- `NVIDIA_AUDIENCE_TIMEOUT_MS` with a bounded default; and
- `GUIDE_AUDIENCE_BLOCK_ENABLED`, defaulting to `false`.

The feature flag controls enforcement, not the classifier's validation rules. With
the flag off, the app may run approved non-production fixture/shadow checks but may
not change Meta sends. With it on, failures defer rather than fall through.

Before enabling the flag on a live account, the owner must provide explicit
production-release authorization and a valid production-eligible NVIDIA serving
arrangement. The current free Developer Program key must not be represented as a
production entitlement.

## Validation and rollout

1. Build a deterministic fixture suite containing clear Indic-script and distinctive
   South-Asian names, weak Latin-script signals, Western names, generic handles,
   empty identities, malformed provider output, injection-shaped profile strings,
   timeout, and identity-change cases. The fixture suite uses synthetic names only.
2. Prove the NVIDIA client returns parseable, schema-valid output with thinking
   disabled. The exploratory credential probe already returned `NVIDIA_OK`; the
   implementation test must use mocked transport and never make external calls.
3. Prove each entry path emits zero Meta sends on `block` and `defer`, while valid
   `unknown` proceeds normally. Cover legacy V1, strict V2, comment public reply,
   DM, quick reply/postback, and redelivery.
4. Deploy code and migration with `GUIDE_AUDIENCE_BLOCK_ENABLED=false`. Verify the
   intended API SHA, applied migration, effective variables, API health, and logs.
5. Review fixture/shadow evidence and the owner-facing audit view. Do not activate
   enforcement while using the developer-only endpoint for live traffic.
6. Once a production-eligible provider is configured and the owner explicitly
   authorizes release, enable the flag, verify fresh decision records, and confirm
   that no blocked decision produced a Meta public reply, DM, or guide-delivery row.

## Acceptance criteria

- A clear high- or low-confidence `south_asian` decision produces no public or
  private Meta send and no guide-delivery plan.
- A valid `unknown` decision follows the same successful guide path it did before.
- Provider failure never becomes `unknown` and never permits a send.
- A cached verdict for an old name/username cannot authorize or block a later
  identity snapshot.
- Existing Gemini historical-recovery classification remains untouched.
- Tests cover the decision matrix and every outbound entry path.
- Production rollout evidence distinguishes local test, deployed code, provider
  credential validation, and live enforcement state.
