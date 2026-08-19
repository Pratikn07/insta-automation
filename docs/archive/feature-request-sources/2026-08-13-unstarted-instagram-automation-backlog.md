# Instagram Automation Candidate Feature Register

**Status:** Discovery backlog for discussion; no feature in this document is approved for implementation.

**Audit date:** 2026-08-13

## Purpose

This document preserves feature ideas found while reviewing the Instagram Automation repository,
its worktrees, and the available Codex, Claude, and Cursor transcripts. It is a decision aid for a
future conversation with an implementation agent. It deliberately records alternatives and open
questions instead of pretending that product decisions have already been made.

This is not an implementation plan. The next agent should select one feature, revalidate the
current code and external platform constraints, brainstorm it with the owner, write an approved
design, and only then produce an implementation plan.

## Status language

| Status | Meaning |
|---|---|
| Candidate | Discussed in a transcript, but no approved design or implementation was found. |
| Previously designed | A design exists, but current implementation status requires revalidation. |
| Partially started | Some code exists outside the current shipped path or covers only part of the idea. |
| Shipped foundation | Supporting functionality exists; the expansion described here does not. |
| Infeasible as stated | The original form depends on data or behavior the current platform does not provide. |

## Rules for the next agent

1. Treat every entry as a hypothesis, not a commitment.
2. Recheck `origin/main`, production configuration, and current Meta API policy before designing.
3. Ask the owner to choose among the recorded options; do not silently choose the most elaborate
   version.
4. Keep AI-generated outbound messages owner-approved unless a separately approved, measured, and
   policy-compliant experiment explicitly changes that boundary.
5. Keep Instagram credentials and send primitives in the main Tiny SOHO API. The Codex runtime
   should not receive them.
6. Use one feature per design and implementation plan. Several entries below are independent
   products, not one large project.
7. Do not merge the stale `ai-followup-experiment` worktree directly. It is 258 commits behind
   `origin/main`; salvage requirements and tests only after revalidating them against current code.
8. Define the smallest experiment that can disprove the idea before building a complete system.
9. Record privacy, consent, rate-limit, messaging-window, and ambiguous-send behavior explicitly.

## Delivered baseline that must not be mistaken for unfinished work

The following foundation was found on the current mainline and should be preserved:

- A private Codex runtime hosted separately from the main API.
- Owner ChatGPT subscription connection without an OpenAI API key.
- Instagram DM capture and structured Codex reply drafts.
- Owner editing, regeneration, dismissal, and explicit **Approve & Send**.
- One scheduled, owner-reviewed engagement follow-up after successful guide delivery.
- A persistent, read-only Tiny SOHO business advisor.
- Feed follower-attribution views and directional Reel spike candidates.
- Country/date follower-flow filters and Growth Lab recommendations.
- Historical read-recovery and controlled campaign tooling.

Related shipped designs:

- [Codex Integration for Tiny SOHO](../superpowers/specs/2026-08-04-codex-tiny-soho-integration-design.md)
- [Owner-Approved DM Drafts and Engagement Follow-Ups](../superpowers/specs/2026-08-05-owner-approved-drafts-and-follow-ups-design.md)
- [Feed Follow Attribution Drawer](../superpowers/specs/2026-08-04-feed-follow-attribution-drawer-design.md)
- [US Growth Lab](../superpowers/specs/2026-07-10-us-growth-lab-design.md)

## Feature inventory

| ID | Candidate | Audit status | First decision |
|---|---|---|---|
| IA-FR-001 | Codex Engagement Copilot evolution | Shipped foundation + partially started experiment | Owner approval only, supervised automation, or autonomous agent? |
| IA-FR-002 | Repost and Advocacy Engine | Candidate; one prompt was prototyped | Simple ask, measured experiment, or rewards program? |
| IA-FR-003 | Personalized Shareable Parenting Artifacts | Candidate | Static templates, personalized images, or interactive artifacts? |
| IA-FR-004 | Parent Ambassador and Referral Program | Candidate | Manual pilot, codes/links, or full program? |
| IA-FR-005 | Trial Reel Tracking and Experiments | Candidate | Manual classification or API-derived classification? |
| IA-FR-006 | Audience Intelligence and Profile Enrichment | Candidate; feasibility unproven | First-party aggregate insight or external enrichment? |
| IA-FR-007 | Competitor Intelligence and Guide Opportunities | Candidate; feasibility unproven | Manual input or external collection? |
| IA-FR-008 | Creator and Partnership Discovery | Candidate; feasibility unproven | Discovery list or managed outreach workflow? |
| IA-FR-009 | Product and Resource Catalog | Candidate; previously deferred | Lightweight structured blocks or normalized catalog? |
| IA-FR-010 | Historical Lifetime Content Leaders | Candidate | Cumulative truth only or forward snapshots too? |
| IA-FR-011 | Shared Business Memory for Assistants | Candidate; native sharing infeasible | Repository brief or custom memory service? |
| IA-FR-012 | Age-Aware Parent Profile and Next-Resource Loop | Previously designed; implementation not found | Ask exact age, age band, or no proactive question? |
| IA-FR-013 | Timely Prospective Recovery Experiment | Candidate; data-backed opportunity | Test reminder timing, copy, or both? |

---

## IA-FR-001 — Codex Engagement Copilot Evolution

**Audit status:** The safe foundation is shipped. A more autonomous experiment was partially built
in `.worktrees/ai-followup-experiment` but was never merged or shipped.

### Opportunity

Use Codex to help Tiny SOHO sustain useful conversations after guide delivery, learn what parents
need, and recognize moments where a gentle next action could help the parent or grow the account.
The feature should reduce owner workload without making users feel manipulated or exposing them to
unsafe automated advice.

### What exists now

- Codex captures context and drafts replies to inbound DMs.
- The owner sees the exact draft and chooses whether to edit, dismiss, regenerate, or send it.
- One engagement follow-up can be scheduled after a successfully delivered guide, but it still
  requires owner approval.
- The business advisor can query bounded read-only funnel data and make recommendations.
- The Codex runtime has no Instagram credentials or send primitive.

### What the unfinished experiment attempted

The stale worktree contains concepts worth discussing, not production-ready code:

- Deterministic control/autonomous assignment, initially shaped as a 30% autonomous arm.
- A guarded conversation window and a maximum of three autonomous replies.
- Independent Codex safety review before a send and after new inbound messages.
- Handoff on uncertainty, unsupported media, hostility, prompt injection, health/development,
  payment, or legal topics.
- One optional repost request only after explicit positive feedback.
- Tracking whether a repost was requested or self-reported as completed.
- Follow-up experiment metrics and a dashboard panel.

The prototype's timing and policy assumptions must be revalidated. In particular, a locally coded
72-hour autonomy envelope does not itself grant permission to message outside Meta's applicable
messaging window.

### Product directions to discuss

#### Option A — Owner-approved copilot only

Codex prioritizes conversations, classifies intent, and drafts replies or next actions. Every
outbound message remains owner-approved.

**Benefits:** Lowest policy and brand risk; builds on shipped architecture.

**Costs:** Owner attention remains the throughput limit; delayed approval can cause messaging
windows to expire.

#### Option B — Supervised, staged automation

Keep owner approval as the default. After shadow evaluation, permit a narrow allowlist of ordinary,
low-risk messages to auto-send inside a valid messaging window. Use deterministic control groups,
hard caps, an independent safety decision, escalation, and a kill switch.

**Benefits:** Tests whether automation creates useful conversations while preserving measurable
controls.

**Costs:** Considerably more state, safety review, policy verification, monitoring, and operational
responsibility.

#### Option C — Fully autonomous conversation agent

Codex independently chooses and sends most conversational replies.

**Benefits:** Highest theoretical responsiveness and lowest owner workload.

**Costs:** Highest brand, safety, medical-boundary, platform-policy, and failure-recovery risk. This
should not be treated as a default or as a simple extension of the current system.

### Possible staged experiments

1. **Shadow classification:** Codex recommends `reply`, `complete`, or `handoff` without sending.
2. **Owner-reviewed quality baseline:** Measure approval rate, edits, warnings, and response
   outcomes by message type.
3. **One allowlisted response type:** Test only a low-risk conversational acknowledgement or
   guide-related question inside the confirmed messaging window.
4. **Positive-feedback repost prompt:** Test one optional request after explicit positive feedback.
5. **Broader conversation handling:** Consider only if the narrow experiment is safe and useful.

### Decisions to make with the next agent

- Is the main goal faster replies, deeper parent insight, repeat guide use, reposts, or owner time
  saved?
- Which message types are safe enough for shadow evaluation or automation?
- What always requires human review?
- What constitutes explicit positive feedback?
- Should an automated message identify itself as automated even when not legally required?
- What is the maximum number of messages and the per-person cooldown?
- Which Meta messaging window applies to every proposed send path?
- How should unsupported media, medical/development questions, hostility, opt-outs, and prompt
  injection be escalated?
- What sample size and safety thresholds must pass before expanding an experiment?

### Measurement candidates

- Draft approval and dismissal rates.
- Edit distance between suggested and approved text.
- Time from inbound message to draft and to send.
- Reply rate and meaningful-reply rate.
- Guide-specific questions and content gaps discovered.
- Repost-prompt rate and confirmed repost rate.
- Opt-outs, complaints, blocks, negative replies, safety handoffs, and ambiguous sends.
- Owner minutes spent per useful conversation.
- Control-versus-treatment lift with confidence intervals, not raw totals alone.

### Non-negotiable constraints to discuss before implementation

- Never make guide access conditional on following, sharing, reposting, paying, or replying.
- Do not diagnose medical, developmental, or psychological conditions.
- Do not impersonate the owner or claim personal review that did not happen.
- Fail closed when Codex, the independent review, policy state, or send outcome is uncertain.
- Keep exact outbound text, decision evidence, model/prompt versions, and outcomes auditable.
- Keep Codex isolated from production credentials and direct send primitives.

### Evidence that a future design is ready

- The approved autonomy boundary is stated in one unambiguous sentence.
- Eligible and ineligible message classes are enumerated with examples.
- Messaging-window and consent rules are verified against current primary Meta documentation.
- The experiment, control group, stop conditions, escalation path, and rollback are measurable.
- No stale-worktree code is adopted without tests against current `main`.

---

## IA-FR-002 — Repost and Advocacy Engine

**Audit status:** The full feature was only brainstormed. The stale Codex experiment prototyped one
small part: an optional repost request after explicit positive feedback.

### Opportunity

Turn genuinely helpful guide interactions into voluntary advocacy without making the guide feel
transactional. Measure which asks, moments, and rewards create authentic reach.

### Product directions to discuss

- **Simple one-time ask:** After clear positive feedback, ask whether the person would like to
  repost the original Reel.
- **Channel experiment:** Compare native repost, Story share, send-to-a-friend, and no ask.
- **Advocacy ladder:** Offer milestones at 1, 3, 5, or 10 verified actions.
- **Campaign engine:** Let the owner configure eligible guides/Reels, timing, copy, caps, rewards,
  and experiment arms.

### Decisions to make

- Is the desired action a repost, Story share, mention, referral, or private recommendation?
- Can the selected action be verified through an API, or is self-report the only signal?
- Are rewards monetary, digital, recognition-based, or absent?
- What frequency cap prevents repeated asks?
- Is Codex allowed to detect positive feedback, draft the ask, or send it?
- Should this remain separate from the ambassador program?

### Smallest useful experiment

Choose one Reel or guide, one ask, one treatment group, one control group, a strict per-person cap,
and a short dashboard covering asks, replies, self-reported completions, negative signals, and any
observable reach change.

### Dependencies and risks

- Depends on a reliable definition of explicit positive feedback.
- Repost/Story verification may be incomplete; verify Meta capabilities before designing storage.
- Rewards can create disclosure, fraud, tax, and platform-policy obligations.
- Poorly timed asks can damage trust even when technically compliant.

---

## IA-FR-003 — Personalized Shareable Parenting Artifacts

**Audit status:** Candidate only.

### Opportunity

Create a useful result a parent wants to save or share: a bedtime plan, activity card, milestone
card, routine checklist, or an `Add Yours` prompt carrying subtle Tiny SOHO attribution.

### Product directions to discuss

- **Static template library:** Curated cards by topic or age band.
- **Light personalization:** Fill a reviewed template with age band, goal, and selected routine.
- **AI-generated visual:** Produce a custom branded image after owner or user confirmation.
- **Interactive artifact:** A small webpage that can be edited, saved, or shared.

### Decisions to make

- Which single artifact solves the strongest measured parent need?
- Is personalization based on exact age, age band, guide history, or an explicit answer?
- Does generation happen automatically or only after owner approval?
- What user data may appear on a shareable image?
- How visible should Tiny SOHO branding be?
- Is Instagram sharing deep-linked, instructed manually, or merely available as an export?

### Smallest useful experiment

Use one reviewed static template for one high-volume guide. Measure creation, save/download, share
intent, actual observable mentions, repeat guide requests, and qualitative replies before adding
AI image generation or a generalized editor.

### Dependencies and risks

- Needs privacy review because shareable media can expose child names, ages, or routines.
- Needs accessible, mobile-first rendering and deterministic fallback output.
- Actual sharing may be hard to observe; do not claim attribution the platform cannot provide.

---

## IA-FR-004 — Parent Ambassador and Referral Program

**Audit status:** Candidate only.

### Opportunity

Invite enthusiastic parents into an ongoing referral or ambassador relationship, with clear
recognition and transparent rewards.

### Product directions to discuss

- **Manual pilot:** Owner selects a small cohort and tracks introductions manually.
- **Referral codes or links:** Attribute registrations or purchases to a parent.
- **Milestone program:** Recognition or rewards at defined verified outcomes.
- **Ambassador dashboard:** Applications, status, assets, referrals, rewards, and communication.

### Decisions to make

- What outcome counts: Instagram follow, guide request, Circle join, purchase, or another event?
- Which outcomes are actually observable end to end?
- Who is eligible, and is invitation owner-selected or automated?
- What rewards and disclosure language are required?
- How are duplicate, self, fraudulent, or unattributed referrals handled?
- Should this be independent of the Repost and Advocacy Engine?

### Smallest useful experiment

Run a manually reviewed cohort with one reward and one verifiable outcome. Do not build a full
ledger or portal until attribution and repeat participation are demonstrated.

### Dependencies and risks

- Circle joins were previously identified as lacking a usable per-user API signal.
- Rewarded advocacy may require disclosure and jurisdiction-specific review.
- Attribution must survive link sharing, duplicate identities, and delayed conversion.

---

## IA-FR-005 — Trial Reel Tracking and Experiments

**Audit status:** Candidate only. Existing stored post data was not found to distinguish Trial
Reels from ordinary Reels.

### Opportunity

Compare Trial Reels with regular Reels, identify which hooks work with non-followers, and decide
which concepts deserve a full release or variation.

### Product directions to discuss

- **Manual tagging:** Owner marks a Reel as trial or regular and records the tested hook.
- **API-derived tagging:** Use Meta data only if a stable Trial Reel field is currently available.
- **Experiment runner:** Pre-register hypothesis, creative variable, comparison window, and success
  rule.
- **Recommendation layer:** Suggest the next hook or variation from historical outcomes.

### Decisions to make

- Can Meta expose Trial status for the connected account and current API version?
- Which outcomes matter: non-follower reach, watch time, shares, profile visits, follows, or guide
  conversions?
- What is the comparison window and minimum sample?
- How will multiple simultaneous creative changes be handled?
- Is the feature descriptive or allowed to recommend the next test?

### Smallest useful experiment

Add manual Trial/regular classification plus a hook label and compare a small, fixed set of metrics
over the same age window. Automate detection only if the API is proven.

### Dependencies and risks

- Exact per-Reel follower attribution is not available historically; use directional language.
- Different posting times and audience sizes can make naive comparisons misleading.
- Meta fields and Trial Reel support can change and must be verified from primary documentation.

---

## IA-FR-006 — Audience Intelligence and Profile Enrichment

**Audit status:** Candidate. Bright Data and Apify were discussed as plausible sources, but coverage,
accuracy, privacy, and platform-policy risk were not established.

### Opportunity

Understand who engages with Tiny SOHO and which topics, languages, needs, and audience categories
correlate with useful conversations, guide completion, retention, or conversion.

### Product directions to discuss

- **First-party aggregate intelligence:** Analyze only interactions and answers already collected
  by Tiny SOHO.
- **Small external enrichment proof of concept:** Test 50–100 public profiles and measure coverage,
  accuracy, cost, and risk before designing a product.
- **Ongoing external enrichment:** Enrich new participants after interaction.
- **Aggregate segments only:** Discard raw profile detail after deriving reviewed, non-sensitive
  categories.

### Decisions to make

- What decision will the data change?
- Is enrichment needed at the individual level or only in aggregate?
- Which fields are permitted, useful, and accurate enough?
- How are consent, deletion, retention, access, and incorrect classifications handled?
- Which sensitive inferences are explicitly prohibited?
- Does the value justify reliance on an external collector?

### Smallest useful experiment

Write the decision question first, then test 50–100 profiles. Record field coverage, false
classifications, cost, latency, deletion behavior, provider terms, and whether the results change a
real content or product decision.

### Dependencies and risks

- Public visibility does not remove privacy, fairness, or platform-policy obligations.
- Names and usernames are not reliable geography, ethnicity, parenting status, or intent.
- External providers add cost, availability, provenance, and deletion dependencies.

Related prior note:
[DM Personalization Logic](../superpowers/specs/2026-08-04-dm-personalization-logic.md).

---

## IA-FR-007 — Competitor Intelligence and Guide Opportunities

**Audit status:** Candidate. External collection plus Gemini analysis was discussed; no integration
was found.

### Opportunity

Study competitor Reels, captions, comments, and recurring parent questions to identify content
patterns and unmet needs that could become Tiny SOHO guides or experiments.

### Product directions to discuss

- **Manual research inbox:** Owner adds public post URLs or exported material for analysis.
- **Monitored competitor set:** An external provider periodically collects a bounded list of public
  accounts and posts.
- **Guide Opportunities view:** Cluster recurring questions, frustrations, and requests, with links
  back to evidence.
- **Creative-pattern analysis:** Compare hooks, formats, themes, and audience response without
  copying protected expression.

### Decisions to make

- Which competitors or adjacent creators are in scope?
- Is manual URL submission sufficient for the first version?
- What data may be collected, stored, quoted, and retained?
- Which model performs classification, and how is unsupported inference prevented?
- What evidence threshold promotes a cluster into a guide opportunity?
- Who reviews recommendations before content is created?

### Smallest useful experiment

Analyze a manually supplied sample of posts and comments from a few accounts. Produce a reviewed
list of repeated problems with source links and confidence. Do not automate collection until the
analysis changes a real content decision.

### Dependencies and risks

- Requires provider/API and copyright/terms review.
- Popular comments are not necessarily representative customer research.
- Generated summaries must link to provenance and avoid fabricated quotes or counts.

---

## IA-FR-008 — Creator and Partnership Discovery

**Audit status:** Candidate; mentioned as a possible use of externally collected public data.

### Opportunity

Find creators or complementary parenting accounts whose audiences, topics, geography, and brand
style may fit a Tiny SOHO collaboration.

### Product directions to discuss

- **Discovery shortlist:** Score and explain potential partners; owner handles outreach elsewhere.
- **Campaign workspace:** Track review, contact status, collaboration idea, and outcome.
- **Inbound-first matching:** Identify creators already engaging with Tiny SOHO.
- **Audience-overlap model:** Estimate fit using aggregate public signals when reliable.

### Decisions to make

- What defines a good partner: topic, audience, geography, engagement quality, size, or values?
- Is discovery enough, or is outreach management part of the product?
- What data source is lawful, stable, and accurate enough?
- Will any outreach be drafted by Codex, and will sending always remain owner-controlled?
- How are sponsorship disclosure and conflicts tracked?

### Smallest useful experiment

Build a manually reviewed shortlist of 20 candidates with evidence for each score. Ask whether the
list produces viable conversations before implementing collection, ranking, or outreach tooling.

---

## IA-FR-009 — Product and Resource Catalog

**Audit status:** Candidate and previously deferred. Historical designs explicitly described
`products` and `resource_products` as a real feature whose demand was not yet proven.

### Opportunity

Store recommended products, materials, books, and links once, reuse them across multiple guides,
and prevent inconsistent or broken recommendations embedded in guide prose.

### Product directions to discuss

- **Structured block inside a guide:** Lowest-cost representation with little reuse.
- **Normalized catalog:** `products` plus a many-to-many resource relationship.
- **Curated collections:** Age/topic-specific material lists assembled from the catalog.
- **Affiliate-aware catalog:** Track merchant, region, disclosure, link health, and attribution.

### Decisions to make

- Is the first need editorial reuse, link safety, affiliate revenue, or user-facing browsing?
- Which item kinds are supported?
- Can one item have regional alternatives?
- Who owns link validation and replacement?
- How are affiliate disclosures rendered?
- Should unavailable products be hidden, substituted, or left visible with a warning?

### Smallest useful experiment

Inventory repeated products across the highest-volume guides. If meaningful duplication exists,
normalize only those items and render them through the existing resource delivery path.

### Dependencies and risks

- Current evidence showed very low delivery volume for `Book` and `Link` resource kinds.
- Affiliate links introduce disclosure, region, availability, and maintenance requirements.
- Catalog normalization can become expensive before the user-facing need is proven.

Related prior designs:

- [DM Personalization Logic](../superpowers/specs/2026-08-04-dm-personalization-logic.md)
- [Personalized DM Ecosystem](../superpowers/specs/2026-08-04-personalized-dm-ecosystem-design.md)

---

## IA-FR-010 — Historical Lifetime Content Leaders

**Audit status:** Candidate. Current attribution work covers feed follower attribution and
directional Reel spikes, but an explicit lifetime historical-leaders experience was not found.

### Opportunity

Show which historical feed posts have the strongest cumulative follow results without pretending
that exact past daily attribution can be reconstructed.

### Product directions to discuss

- **Cumulative lifetime table:** Display only lifetime values Meta currently provides.
- **Forward snapshot history:** Begin storing cumulative values so future deltas can be calculated.
- **Mixed historical/forward view:** Clearly distinguish lifetime totals from post-deployment
  increments.
- **Modeled estimate:** Estimate historical periods with explicit uncertainty; highest risk of
  confusing users.

### Decisions to make

- What exact lifetime metrics are available for each media type now?
- Is ranking cumulative totals enough, or must content age be normalized?
- How are deleted, unavailable, or changed posts represented?
- Should this live in Feed Attribution, Growth Lab, or a separate content table?
- What language prevents lifetime totals from being read as precise daily attribution?

### Smallest useful experiment

Add a read-only lifetime leaders table from verifiable cumulative fields and start daily snapshots
for future deltas. Do not backfill invented daily values.

---

## IA-FR-011 — Shared Business Memory for Assistants

**Audit status:** Candidate. Native ChatGPT/Codex memory sharing solely because two assistants use
the same authentication was found to be unavailable. A custom memory layer was suggested but not
found in the product.

### Opportunity

Give future Codex tasks and the in-product advisor a shared, current understanding of approved
brand rules, experiments, decisions, audience learnings, and unresolved questions.

### Product directions to discuss

- **Repository-backed business brief:** A reviewed Markdown/JSON file is the source of truth.
- **Database decision log:** Structured facts with source, owner approval, effective date, and
  supersession.
- **Retrieval service:** Search approved documents and measurements at answer time.
- **Native assistant memory:** Do not plan around this unless a supported product capability is
  verified; same-account authentication is not sufficient.

### Decisions to make

- What deserves durable memory versus ordinary transcript history?
- Who can write or approve a remembered fact?
- How are conflicting and superseded decisions handled?
- What provenance and expiry are required?
- Which assistants may read each category?
- Can parent-specific data enter memory, or must it remain in purpose-specific DM storage?

### Smallest useful experiment

Maintain one owner-reviewed business brief containing brand voice, active experiments, approved
policies, and current priorities. Let the advisor read it, but require explicit owner review for
updates. Evaluate drift and usefulness before building a generalized memory service.

### Dependencies and risks

- Memory without provenance can amplify old or incorrect decisions.
- Parent data raises purpose limitation, deletion, and access-control concerns.
- A custom store must not become a hidden action channel around the read-only advisor boundary.

---

## IA-FR-012 — Age-Aware Parent Profile and Next-Resource Loop

**Audit status:** Previously designed in the personalization documents, but no matching participant
profile, age-question, or routing implementation was found in the current mainline search. The next
agent must verify this again before treating it as unstarted.

### Opportunity

After a parent receives a guide, ask one useful question, learn the child's age or age band, and
offer a genuinely relevant next resource. Aggregate answers can also expose content gaps, such as
needs for younger infants not covered by the current catalog.

### Product directions to discuss

- **Exact age question:** Ask for age in months/years and parse it into a normalized range.
- **Age-band choice:** Offer a few broad ranges, reducing parsing and privacy complexity.
- **Need-first question:** Ask what the parent is struggling with instead of age.
- **No proactive question:** Extract only voluntarily supplied details and keep Codex in draft mode.

### Decisions to make

- Is age the highest-value and least intrusive first question?
- When is the question sent, and does it require owner approval?
- How are twins, multiple children, pregnancy, unclear answers, and changed ages represented?
- Which routing table maps an age/need to a resource?
- What happens when no safe, relevant resource exists?
- How long is profile data retained, and can the parent correct or delete it?

### Smallest useful experiment

For one guide and one owner-reviewed follow-up, ask one age-band question and measure answer rate.
Do not build generalized profiles or routing unless enough parents answer and the answer changes a
useful next action.

### Measurement candidates

- Answer rate to the first question.
- Percent of answers parsed confidently.
- Second-guide request and delivery rate.
- Unhandled parent questions.
- Guide gaps by age band or stated need.
- Retention or follow-through after a useful second interaction.

### Dependencies and risks

- Must respect messaging-window and owner-approval boundaries.
- Age and family details require clear purpose, minimization, retention, and deletion rules.
- A recommendation must not become medical or developmental diagnosis.

Related prior designs:

- [DM Personalization Logic](../superpowers/specs/2026-08-04-dm-personalization-logic.md)
- [Personalized DM Ecosystem](../superpowers/specs/2026-08-04-personalized-dm-ecosystem-design.md)

---

## IA-FR-013 — Timely Prospective Recovery Experiment

**Audit status:** Candidate. Historical recovery and prospective reminder foundations are shipped,
but this proposed timing-and-copy experiment has not been approved or implemented.

### Opportunity

Recover recent guide requests while intent is still fresh. The historical campaign proved that the
public-comment-to-DM path works, but also showed that old requests are a weak growth lever. The
next experiment should focus on people whose original gate DM was accepted by Instagram but who
showed no subsequent engagement, and remind them within hours rather than weeks.

### Measured evidence

Production attribution checked on 2026-08-16 showed:

- 645 unique people received a historical recovery comment.
- 6 later sent an inbound DM (0.93%).
- 4 returned inside the configured attribution window and completed the matching keyword flow
  (0.62%).
- Of 533 historical control/holdout users who received no reminder, 2 returned to DM and 1
  completed the matching keyword flow.

Instagram does not provide proof that a person viewed a recovery comment. The observable evidence
is the sequence `comment sent -> later inbound DM`; a matching-keyword completion is the stronger
outcome. The treatment and historical control cohorts were not a clean contemporaneous comparison,
so these figures suggest an opportunity but do not establish causal lift.

The primary leak is before the DM: once a contacted person returned, 4 of 6 completed the matching
keyword flow. This points toward testing reminder timing and clarity before investing in more
historical selection or origin-classification work.

### Recommended smallest experiment

Run one controlled prospective experiment:

- Eligible population: new guide requests where Instagram accepted the original gate DM and no
  read, reply, reaction, postback, matching-keyword completion, or newer journey is recorded.
- Timing: send one public reminder 6–12 hours after the original request, subject to revalidation
  against current product behavior and Meta policy.
- Assignment: deterministic 50% treatment and 50% control, frozen before any reminder is sent.
- Treatment copy to evaluate:

  > I sent your guide, but Instagram may have placed it in Requests. DM me **[KEYWORD]** and I’ll
  > send it again.

- Pacing: begin with a shared maximum of 10 public reminders per rolling hour.
- Primary outcome: matching-keyword completion within 48 hours of the reminder/control anchor.
- Secondary outcome: any inbound DM within the configured attribution window.
- Safety outcomes: complaints, blocks, opt-outs, negative replies, deleted/hidden source comments,
  ambiguous sends, and circuit-breaker state.
- Evaluation target: approximately 1,000 eligible people per arm, or an earlier statistically and
  operationally justified stop for harm, futility, or clear benefit.

The control arm must not be contacted by this experiment. Guide access remains unconditional, and
each treatment person receives at most one reminder for the eligible request.

### Product directions to discuss

#### Option A — Timing-only test

Keep the existing reminder copy and compare a recent 6–12-hour reminder with control.

**Benefits:** Isolates whether freshness is the missing factor.

**Costs:** Preserves copy that may not clearly explain Requests or tell the person exactly what to
do next.

#### Option B — Copy-only test

Keep current timing and test one clearer Requests-plus-keyword call to action.

**Benefits:** Isolates copy impact and minimizes scheduler changes.

**Costs:** May spend the sample on people whose intent has already decayed.

#### Option C — Combined timely-copy test against control

Use the recommended copy at 6–12 hours and compare it with no reminder.

**Benefits:** Tests the smallest complete product hypothesis: a timely, explicit reminder can
recover recent intent.

**Costs:** If it wins, a follow-up test is needed to separate timing lift from copy lift.

### Decisions to make

- Is 6, 8, 10, or 12 hours the treatment delay?
- What exact events prove engagement and suppress the reminder?
- Should eligibility remain limited by the current audience policy, and which segments are
  included?
- Is the proposed copy acceptable as written, or does the owner want one reviewed alternative?
- Is 50/50 assignment acceptable until the experiment reaches its sample target?
- What minimum absolute lift justifies retaining the reminder?
- Which safety event pauses one campaign, and which opens the shared circuit breaker?
- Does the available eligible volume support 1,000 people per arm within a useful timeframe?

### Non-negotiable safeguards

- Recheck completion, inbound engagement, source-comment availability, newer journeys, audience
  policy, prior recovery, pacing capacity, and circuit state immediately before every send.
- Never retry an ambiguous public-comment outcome automatically.
- Do not contact control users through this experiment.
- Do not increase pacing without a separate owner decision supported by health data.
- Keep exact assignment, eligibility evidence, approved copy, source comment, provider reply ID,
  and outcome auditable.
- Stop or pause on complaint, block, opt-out, negative-reply, authentication, permission, or
  provider-safety signals according to the approved design.

### Evidence that a future design is ready

- Eligibility and suppression rules are stated as deterministic predicates.
- Treatment timing, copy, control assignment, sample target, and success threshold are explicit.
- Meta/platform constraints are reverified against current primary sources and production behavior.
- Attribution distinguishes any inbound DM from exact matching-keyword completion.
- The design specifies durable pacing, idempotency, ambiguous-send handling, stop conditions,
  monitoring, and rollback.
- The owner explicitly approves the focused design before implementation begins.

---

## Ideas that should not be presented as ordinary buildable features

These appeared in the surrounding conversations but need a feasibility correction:

| Idea | Current conclusion |
|---|---|
| Exact historical daily Reel follow attribution | Meta provides insufficient historical per-Reel follow data. Keep directional spike language unless new primary-source capabilities are verified. |
| Native memory shared automatically between ChatGPT and Codex | Same-account authentication does not create a shared application memory. Consider IA-FR-011 instead. |
| Exact per-user geography from existing Instagram data | No reliable route was identified. Do not substitute name/username inference and call it geography. |
| Exact per-user Circle join tracking | No usable API route was identified in the prior audit. Revalidate before selecting it as a referral outcome. |
| Autonomous sends outside Meta's applicable messaging window | Not enabled by Codex, owner authentication, or a local timer. Every send path must independently satisfy current Meta rules. |

## Completed or superseded ideas excluded from the candidate count

- Feed follow attribution and its detail drawer.
- Directional Reel spike candidates.
- Country/date follower-flow filters and country drilldown.
- Growth Lab capture-rate and next-test recommendations.
- Codex runtime and ChatGPT connection.
- Owner-approved DM drafting and sending.
- Read-only business advisor.
- Owner-approved post-guide engagement follow-ups.
- Historical recovery and the prior Features 1–4 recovery work.

The existence of a shipped foundation does not decide whether one of the expansion candidates in
this register should be built.

## Initial sequencing hypotheses, not decisions

The owner and next agent should revisit priority based on the desired business outcome. Reasonable
starting sequences include:

### If the goal is more useful parent conversations

1. IA-FR-001 Codex Engagement Copilot discussion and shadow baseline.
2. IA-FR-012 Age-Aware Parent Profile experiment.
3. IA-FR-003 one shareable artifact based on a measured need.

### If the goal is organic reach

1. IA-FR-002 one-request repost experiment.
2. IA-FR-005 Trial Reel tagging and measurement.
3. IA-FR-004 manual ambassador pilot.

### If the goal is better content strategy

1. IA-FR-005 Trial Reel tagging.
2. IA-FR-007 manual competitor research sample.
3. IA-FR-006 first-party audience intelligence before external enrichment.

### If the goal is infrastructure and continuity

1. IA-FR-011 reviewed repository-backed business brief.
2. IA-FR-009 validate repeated-product demand.
3. IA-FR-010 begin forward lifetime-metric snapshots.

## Transcript audit index

These task identifiers and titles were part of the source audit. They are included for discovery,
not as proof of approval:

| Task ID | Subject |
|---|---|
| `019fd592-fdb7-72a0-b0d2-055c3d25993f` | Research Instagram growth tactics |
| `019fd49c-0670-7180-8c74-5e7b8c368c0a` | Related Instagram growth research |
| `019fcb0e-d281-7821-940c-6142e980cc47` | Investigate ChatGPT SSO integration (2) |
| `019fca31-3ba8-7581-aa0b-9e5d88bd6d88` | Original ChatGPT SSO, Bright Data, and product brainstorm |
| `019fd589-328e-7e73-b95f-daea42362686` | Check AI assistant memory sharing |
| `019fceff-92ba-7591-a493-e05f747eed7f` | Follower attribution discussion |

## Handoff prompt for another agent

Use the following prompt after choosing one candidate:

> Read `docs/feature-requests/2026-08-13-unstarted-instagram-automation-backlog.md` and the linked
> existing designs. Focus only on **[FEATURE ID AND NAME]**. First verify its audit status against
> current `origin/main`, all relevant worktrees, production configuration available to you, and
> current primary platform documentation. Then brainstorm the recorded options with me one decision
> at a time. Do not implement or write an implementation plan until I explicitly approve a focused
> design. Preserve the current credential, owner-approval, audit, messaging-window, and
> ambiguous-send safety boundaries unless the approved design explicitly and lawfully changes one.

## Decision record template

When a feature is discussed, append or create a separate approved design containing:

- Selected problem and target user.
- Selected option and rejected alternatives with reasons.
- Measurable success and stop conditions.
- Included and excluded scope.
- Data source and provenance.
- Privacy, policy, safety, and owner-approval boundary.
- User and system flow.
- Failure, retry, ambiguous-outcome, and rollback behavior.
- Experiment/control design when applicable.
- Dependencies and rollout order.
- Acceptance criteria and verification plan.

Do not change an entry from `Candidate` to `Approved` merely because an agent recommends it. Record
the owner's explicit decision in the focused design.
