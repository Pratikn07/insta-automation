# Instagram Automation — Canonical Feature Backlog

**Status:** Canonical product portfolio and feature backlog. Nothing in this document is approved for implementation merely because it appears here.

**Canonical as of:** 2026-08-20

**Code baseline checked:** `main` at `2397fce` before the documentation-only consolidation commit, plus every local branch, remote branch, and linked worktree visible on 2026-08-20.

**Account:** `@tinysoho`

## Why this document exists

Three overlapping feature-request documents were created from different transcript audits. They mixed speculative ideas, near-term requests, recovered designs, operational actions, completed work, and duplicate entries. This document replaces those three as the single active working backlog.

It does five things:

1. Preserves the useful evidence, options, constraints, and acceptance criteria from every source.
2. Consolidates duplicates under one canonical ID without losing their original IDs.
3. Corrects status notes that became stale after the source audits.
4. Separates product opportunities from correctness fixes, operational decisions, infeasible ideas, and already-completed work.
5. Keeps one stable entry through the complete lifecycle from candidate to approved, in progress, shipped, declined, or superseded.

The three source audits were committed long enough to verify this consolidation and were then removed from the working tree so they cannot be mistaken for active backlogs. Their original contents remain recoverable through Git history.

## How to use this backlog

Do not build the entire document as one project. Each canonical item is an independent decision unit unless its dependency section says otherwise.

For any item selected for work:

1. Revalidate its code, production data, configuration, and external-platform assumptions.
2. Resolve the listed owner decisions one at a time.
3. Define the smallest experiment or slice that can disprove the idea.
4. Write and approve one focused design.
5. Produce an implementation plan only after the design is approved.
6. Implement on a branch or worktree with appropriate tests and rollout controls.

An entry's recommendation is a starting point, not approval. Change an item to `Approved` only when the owner explicitly approves its focused design.

### Authority and lifecycle

This file is the only active feature register. `PRODUCT.md` describes the product that exists; focused specs and plans describe how one selected feature should work; this file records every proposed feature, its current state, and the links between those artifacts.

Start every item state with one of these lifecycle states, then append a short evidence or activation qualifier where useful:

| State | Meaning |
|---|---|
| `Candidate` | The idea is preserved, but its value, scope, or feasibility is not approved. |
| `Needs decision` | Evidence exists, but an owner choice blocks focused design. |
| `Approved` | The owner approved a focused design; implementation has not started. |
| `In progress` | Work exists on a named branch or worktree but is not established on `main`. |
| `Shipped` | The behavior is on `main`; production activation is recorded separately when relevant. |
| `Declined` | The owner deliberately chose not to pursue it. |
| `Superseded` | Another canonical ID or shipped capability replaced it. |

Never delete a canonical item merely because work started or shipped. Update its state and preserve links to the focused design, plan, branch, merge, and operational decision. A branch name or dirty worktree is evidence of activity, not proof that a feature shipped.

### New-idea intake rule

Add a new idea here before or during its first focused discussion. Give it a stable category ID, record its source and date, and state whether it is distinct from or a slice of an existing item. New specs and implementation plans must name that ID. If another audit is needed, merge its findings into this file and remove the temporary audit document after verification; do not retain a competing active or archived backlog in the working tree.

## Verification rules

The codebase, live production data, Meta API behavior, and product configuration can change after this audit. Before relying on a claim:

- Re-search for symbols instead of trusting historical line numbers.
- Re-run production counts and rates; every baseline below carries its measurement date.
- Check `docs/meta-verification.md` before asserting Graph API behavior.
- Verify current primary Meta documentation for any new messaging or insights path.
- Treat missing documentation as unknown, not permission.
- Use the read-only Supabase connection for analysis. Make writes through reviewed scripts with `--dry-run` before `--write`.
- Parse feature flags using `src/config/booleanFlag.ts`; never use `z.coerce.boolean()`.
- A web build without the required `VITE_SUPABASE_*` variables can exit successfully while producing no usable app. Inspect the output bundle rather than trusting the exit code.

## Product and system context

Tiny SOHO is a toddler-parenting Instagram account serving primarily Western audiences: the United States, United Kingdom, Canada, Australia, and Western Europe.

The primary automated funnel is:

1. A person comments a configured keyword on a Reel.
2. The system posts a public acknowledgement.
3. Instagram permits one private reply containing the gate message.
4. The person replies, normally with `DONE`.
5. The inbound reply opens the messaging window.
6. The requested guide is delivered over DM.
7. The system may send a follower-aware closing line and, where separately approved, prepare an owner-reviewed follow-up.

Important operating facts:

- Roughly 93% of logged comments were mechanical bot replies or bare keywords in the historical audit; only about 2.6% were organic. Raw comment volume is not a reliable audience-quality signal.
- Meta's messaging window is a hard external constraint. A local timer, Codex connection, owner authentication, or `HUMAN_AGENT` assumption does not independently authorize a send.
- Only one private reply can be sent to a person who commented. If the person never replies, there is no legal second automated DM path.
- Public comment reminders are not DMs. They require separate channel presentation, pacing, ambiguous-send handling, and safety controls.
- Guide access must not be conditional on following, reposting, sharing, paying, or answering a profiling question.
- Instagram does not provide exact per-user attribution for several desired outcomes, including broadcast-channel joins and historical Reel follows. The UI must not imply attribution that the platform cannot supply.
- AI-generated parenting text must not diagnose medical, developmental, or psychological conditions.

## Delivered baseline to preserve

The following foundations are already present on `main` and must not be treated as unstarted features:

- A private Codex runtime hosted separately from the main API.
- Owner ChatGPT subscription connection without an OpenAI API key.
- Instagram DM capture and structured reply drafts.
- Owner editing, regeneration, dismissal, and explicit approval-and-send controls.
- One scheduled, owner-reviewed engagement follow-up after successful guide delivery.
- A persistent, read-only Tiny SOHO business advisor.
- Feed follower-attribution views.
- Directional Reel spike candidates, although their current ranking has a known correctness problem described in `REL-002`.
- Country/date follower-flow filters and Growth Lab recommendations.
- Historical recovery and controlled campaign tooling.
- Expanded recovery audience segmentation, merged through PR #12.
- A cohort funnel layer and Funnels page, merged through PR #13.
- A machine-readable resource library with `kind`, `theme`, age ranges, and page-level alternative text.

## Current-state corrections to the source audits

The source documents were checked on 2026-08-13 and 2026-08-14 against older commits. The complete Git-ref and physical-worktree audit was repeated on 2026-08-20. As of this consolidation:

- `feat/expanded-recovery-audience` is no longer merely in flight; PR #12 is merged into `main`.
- The cohort funnel layer and Funnels page are merged through PR #13 and should be reused for funnel measurement.
- `feat/dm-recovery-timing-v2` contains committed and uncommitted work for `GROW-002`; treat that feature as in progress but unmerged, not shipped.
- `feature/follower-aware-comment-gate` contains a focused plan and partial implementation for `GROW-004`; treat it as in progress but unmerged.
- `feature/guide-message-delivery` contains an approved and implemented explicit sequence-save slice that is absent from `main`; it is tracked as `REL-006` rather than left only on that branch.
- `feature/ai-followup-experiment` is a stale, heavily divergent, dirty worktree. Its useful requirements remain inputs to `PARENT-002`; none of its code is an approved merge source.
- The person-lineage endpoint still does not query `DmMessage`, and the frontend still uses the narrow `BOT_KINDS` allowlist. `REL-001` remains open.
- The old `SpikeCandidates`, `spikeCore`, and `spikeService` path remains present. `REL-002` remains open.
- No `child_age_months`, `age_asked_at`, public-reply variant service, or keyword-variant model was found. `PARENT-001` and `GROW-001` remain unstarted.
- The keyword comment handler still sends `keyword.publicReply` without the shared audience-origin policy. `GROW-003` remains open.
- Repository defaults and the deployment runbook still keep `AI_SEND_ENABLED=false` through shadow verification. Production values must be checked separately before any operational decision.
- No additional untracked feature register was found in any linked worktree. Later worktree documents were designs, plans, runbooks, or QA artifacts and were mapped to an existing canonical ID unless they represented a distinct feature.
- The three historical source audits were committed for traceability, fully mapped here, and then removed from the working tree. Git history retains their provenance without leaving competing feature registers on `main`.

## Source-to-canonical mapping

| Source ID | Source title | Canonical disposition |
|---|---|---|
| CT-1 | Public-reply copy A/B test | `GROW-001` |
| CT-2 | Reach-share panel replacing Spike Candidates | `REL-002` |
| CT-3 | Conversations tab breakdown | Duplicate of FR-2; consolidated into `REL-004` |
| FR-1 | DM personalization: the child-age loop | `PARENT-001` |
| FR-2 | Conversations rebuild: one queue, one person view | `REL-004` |
| FR-2a | Person timeline drops AI and recovery events | `REL-001` |
| FR-3 | Origin gate on the keyword auto-reply | `GROW-003` |
| FR-4 | Broadcast-channel invite in the delivery flow | `GROW-006` |
| FR-5 | Known-follower personalized comment gate | `GROW-004` |
| FR-6 | Age/gender demographics and navigation breakdown | `INSIGHT-001` |
| FR-7 | AI surfaces built and switched off | `REL-003` |
| IA-FR-001 | Codex Engagement Copilot evolution | `PARENT-002`; activation prerequisite in `REL-003` |
| IA-FR-002 | Repost and Advocacy Engine | `GROW-005` |
| IA-FR-003 | Personalized Shareable Parenting Artifacts | `PARENT-003` |
| IA-FR-004 | Parent Ambassador and Referral Program | `GROW-007` |
| IA-FR-005 | Trial Reel Tracking and Experiments | `INSIGHT-002` |
| IA-FR-006 | Audience Intelligence and Profile Enrichment | `INSIGHT-003` |
| IA-FR-007 | Competitor Intelligence and Guide Opportunities | `INSIGHT-004` |
| IA-FR-008 | Creator and Partnership Discovery | `INSIGHT-005` |
| IA-FR-009 | Product and Resource Catalog | `PARENT-004` |
| IA-FR-010 | Historical Lifetime Content Leaders | `INSIGHT-006` |
| IA-FR-011 | Shared Business Memory for Assistants | `INFRA-001` |
| IA-FR-012 | Age-Aware Parent Profile and Next-Resource Loop | Duplicate/earlier framing of FR-1; consolidated into `PARENT-001` |
| IA-FR-013 | Timely Prospective Recovery Experiment | `GROW-002` |
| Approved design, 2026-08-07 | Settings-failure fallback, journey deduplication/reconciliation, and historical recovery | Materially shipped before this canonical register; the remaining production reconciliation decision is `REL-005` |
| Owner request, 2026-08-20 | Context-aware public comment engagement using follower history | `GROW-008` |
| Branch design, 2026-08-09 | Explicit save behavior in the sequence editor | `REL-006` |

## Portfolio index

### Reliability and operational correctness

| ID | Item | State | Size | Why it matters |
|---|---|---|---|---|
| `REL-001` | Complete the person timeline | Candidate — confirmed correctness bug | S–M | Successful AI sends and recovery activity can be absent or misleading |
| `REL-002` | Replace Spike Candidates with recent reach share | Candidate — confirmed analytics defect; partial design | M | Current panel drops new Reels and can show the wrong content |
| `REL-003` | Harden and shadow-verify caregiver-aware AI replies | Needs decision — shadow foundation shipped; activation remains blocked | S–M + Ops | Existing drafts need safe timing, a Tiny SOHO voice policy, deterministic checks, and owner review before sending |
| `REL-004` | Rebuild Conversations as one actionable queue and one person view | Candidate — mockups and behavior rules; no spec | M–L | Owner currently scans fragmented object lists instead of people |
| `REL-005` | Apply or explicitly decline journey reconciliation | Needs decision — pending production action | Ops | Shipped reconciliation code remains inert without an owner-approved write |
| `REL-006` | Explicit sequence-editor saves | In progress — unmerged branch | Integration | Approved behavior is implemented on a divergent branch but absent from `main` |

### Growth and funnel experiments

| ID | Item | State | Size | Why it matters |
|---|---|---|---|---|
| `GROW-001` | Public-reply follow-ask A/B test | Candidate — partial design; measurement rules incomplete | M | Tests the only follow ask visible to every commenter |
| `GROW-002` | Timely prospective recovery experiment | In progress — unmerged worktree | M–L | Tests whether a reminder within hours recovers fresh intent |
| `GROW-003` | Shared audience policy on keyword public replies | Needs decision — measured policy gap | S–M | Existing audience flag covers almost none of the relevant public comments |
| `GROW-004` | Known-follower gate wording | In progress — unmerged branch | S | Removes factually wrong follow language for known followers |
| `GROW-005` | Repost and advocacy experiment | Candidate | S experiment; L platform | Tests voluntary sharing after genuine value is delivered |
| `GROW-006` | Broadcast-channel invitation | Needs decision — destination and copy unresolved | S | Invites warm guide recipients into an owned recurring audience |
| `GROW-007` | Parent ambassador and referral pilot | Candidate | M pilot; L platform | Tests higher-commitment advocacy with observable outcomes |
| `GROW-008` | Context-aware public comment engagement | Candidate — focused design required | M–L | Uses prior relationship context to make public guide replies feel attentive without exposing private DM facts |

### Parent value and retention

| ID | Item | State | Size | Why it matters |
|---|---|---|---|---|
| `PARENT-001` | Age-aware parent profile and next-resource loop | Needs decision — historical approval requires revalidation; unbuilt | L, staged | Only proposal built around repeat value rather than one-off delivery |
| `PARENT-002` | Engagement Copilot evolution | Candidate — safe foundation shipped; expansion unapproved | M–XL | Could reduce silence and owner workload while preserving safety |
| `PARENT-003` | Shareable parenting artifacts | Candidate | S experiment; L product | Turns advice into a useful, saveable, naturally shareable result |
| `PARENT-004` | Product and resource catalog | Candidate — deferred pending demand | M–L | Could make recommendations reusable and safer if demand is real |

### Content and audience intelligence

| ID | Item | State | Size | Why it matters |
|---|---|---|---|---|
| `INSIGHT-001` | Age/gender demographics and navigation metrics | Candidate — existing permission likely sufficient | S–M | Improves audience and hook understanding |
| `INSIGHT-002` | Trial Reel tagging and experiments | Candidate — API feasibility unproven | S manual; M–L automated | Establishes comparable creative tests |
| `INSIGHT-003` | Audience intelligence and profile enrichment | Candidate — privacy and feasibility unproven | Spike first | Must prove a decision changes before external enrichment is justified |
| `INSIGHT-004` | Competitor intelligence and guide opportunities | Candidate | Spike first | Tests whether external evidence reveals useful unmet needs |
| `INSIGHT-005` | Creator and partnership discovery | Candidate | Spike first | Tests whether a curated shortlist creates viable collaborations |
| `INSIGHT-006` | Historical lifetime content leaders | Candidate | S–M | Adds cumulative truth without inventing historical daily attribution |

### Infrastructure and continuity

| ID | Item | State | Size | Why it matters |
|---|---|---|---|---|
| `INFRA-001` | Shared, reviewed business memory | Candidate | S brief; L service | Keeps decisions and policies current across assistants with provenance |

## Recommended portfolio sequence

This sequence balances correctness, learning speed, and business value. It is a recommendation, not an implementation plan.

1. **Protect truth and auditability:** `REL-001`, then `REL-002`.
2. **Evaluate what already exists:** run `REL-003` shadow verification without enabling sends.
3. **Test the highest-value retention assumption cheaply:** implement only Slices A and B of `PARENT-001`; measure whether parents answer before building routing.
4. **Finish or deliberately stop active branch work:** rebase and review `REL-006`, `GROW-002`, and `GROW-004` before creating competing implementations.
5. **Select one concurrent growth experiment:** `GROW-001` for public follow-ask learning or `GROW-002` for fresh-intent recovery. Do not launch both simultaneously if their cohorts or outcomes can interfere.
6. **Resolve the audience-policy gap:** decide and design `GROW-003`, now that the expanded audience taxonomy is merged.
7. **Design public-context engagement separately:** resolve the privacy and approval boundary for `GROW-008` before treating it as an extension of private AI replies.
8. **Build the queue around observed work:** design `REL-004` only after shadow drafts or approved sends provide real row content.
9. **Add low-cost insight:** consider `INSIGHT-001`, then manual `INSIGHT-002`.
10. **Keep speculative platforms behind proofs:** require small manual spikes for advocacy, artifacts, external intelligence, partnerships, catalogs, and custom memory before building generalized systems.

---

# Growth and funnel experiments

## GROW-001 — Public-reply follow-ask A/B test

**Source:** CT-1

**State:** Candidate. Product direction was selected historically, but the technical design is partial and analysis queries, sample calculation, and stop rules remain unresolved.

**Size:** Medium. The copy change is trivial; trustworthy experiment instrumentation is the work.

### Original goal and feasibility correction

The original idea was to nudge people who received a gate DM but stayed silent. That version is not buildable: Instagram permits only one private reply to a commenter, and the gate DM already uses it. A normal DM path does not open until the person sends an inbound message.

Do not reintroduce a second-DM proposal for silent commenters. The reachable surface is the public reply on their original comment.

### Historical funnel evidence

Measured for the 30 days ending 2026-08-01:

| Stage | Count |
|---|---:|
| Conversations opened | 1,588 |
| Gate DM delivered | 1,565 |
| User replied | 622, approximately 40% |
| Guide delivered | 655 |

About 943 people received the gate wording but never replied. Everything downstream worked comparatively well.

Supporting findings:

- Of 652 observed guide deliveries, 567 went to people already following at delivery; only 85 were non-followers.
- The hard follow gate fired only 24 times. Its observed conversion was strong but touched very few people.
- Followers grew from 3,567 to 4,696 over 16 days in the historical period, so growth was not broadly broken.
- The public reply reaches all commenters and currently uses most of its copy merely to say `Check your DMs`.
- Reply rates varied materially across keyword wording, suggesting copy can matter.

Use the shipped cohort funnel to revalidate these counts rather than writing a new one-off interpretation.

### Copy directions considered

#### A — Help locate the DM

> Sent it to your DMs 💌 Not there? Peek in your Message Requests.

Low taste risk, but it primarily targets guide delivery rather than follower conversion. Historical data could not establish that DM invisibility caused the silence.

#### B — Put the follow ask in public — historically selected

> Sent it to your DMs 💌 Follow @tinysoho so the next one comes to you first.

The follow ask is visible even if the gate DM is unopened and is also visible to other readers of the comment thread. The risk is repetitive public promotion at the account's comment volume.

#### C — Give a subscription reason

> Sent it 💌 This one is from my toddler-sleep set—new one every week.

Potentially stronger brand logic because it explains why following helps, but it requires truthful cadence claims and topic-specific copy.

### Recommended experiment

Run one concurrent control-versus-follow-ask experiment on the two highest-volume keywords after revalidating volume. Historically `SLEEP` and `POTTY` represented approximately 64% of matches and were the only keywords with enough individual traffic.

At public-reply send time:

1. Resolve a deterministic variant from a stable participant identifier and the experiment/keyword namespace.
2. Keep the same person in the same arm across repeat comments.
3. Send the configured control or treatment text.
4. Snapshot the exact text, variant, experiment version, keyword, comment, person, and timestamp in durable evidence.
5. Analyze both arms concurrently so daily and seasonal wobble affects them equally.

Do not overwrite a keyword's mutable copy and retrospectively join old events to the current value. Historical events must retain the text actually sent.

### Technical direction

- Add a pure assignment function with no I/O.
- Store editable variant copy without requiring a deployment.
- Stamp variant and exact copy on the send evidence.
- Reuse the snapshot pattern already established for recovery reminders.
- Keep the gate DM, follow enforcement, sequence delivery, and private-reply primitive unchanged.
- Avoid a generalized experiment platform in v1 unless another approved experiment has the same immediate contract.
- Avoid a dashboard in v1 if reviewed queries and an export answer the decision.

### Primary and secondary outcomes

**Primary:** gate reply rate after the public acknowledgement.

**Secondary:** guide completion, known follower/non-follower mix at delivery, suppression/error rates, negative replies, hidden/deleted comments where observable, and broad account-level follower direction.

### Attribution limit

The experiment does not prove that an individual public reply caused an Instagram follow. No Graph API join ties the follow to the comment. It can measure reply behavior and follower state observed later in the funnel; follower-count movement is directional context only.

### Remaining decisions

- Approve the exact control and treatment copy.
- Confirm eligible keywords after current-volume analysis.
- Decide whether assignment is per person across both keywords or per person-and-keyword.
- Choose the minimum detectable absolute lift worth acting on.
- Calculate required sample size from the current baseline and desired power.
- Define a minimum runtime that covers day-of-week effects.
- Define harm, futility, and success stop rules.
- Decide whether comments by the same person across multiple posts count once or as repeated exposures in analysis.

### Guardrail and reporting rules

- Below the approved minimum sample, show counts and `null`, not a misleading rate comparison.
- Report absolute lift, relative lift, sample size, and uncertainty.
- Pre-register exclusions and never remove inconvenient observations after assignment.
- Do not change copy during the run. A material copy edit creates a new experiment version.
- Avoid simultaneous experiments that alter the same public reply or downstream gate behavior.
- Cap repeated exposure if brand quality requires it, but define the cap before launch.

### Acceptance criteria

- Assignment is deterministic, stable, approximately balanced, and namespace-versioned.
- The same eligible person does not switch arms during one experiment version.
- Exact sent text and variant are immutable evidence.
- Control behavior is unchanged apart from instrumentation.
- Treatment applies only to approved keywords and configured traffic.
- Queries can compute arm-level eligibility, send success, replies, completions, and safety signals.
- Reports suppress rates below minimum sample.
- Tests cover assignment stability, distribution, copy fallback, logging, duplicate webhooks, and send failure.
- Rollback restores control copy without losing experiment evidence.

### Relationship to other work

- Use current funnel measurement from PR #13.
- Keep `GROW-003` audience-policy behavior constant across both arms or complete it before starting this test.
- Do not overlap with `GROW-002` if recovery reminders would influence the same primary outcome during the measurement window.

---

## GROW-002 — Timely prospective recovery experiment

**Source:** IA-FR-013

**State:** In progress. `feat/dm-recovery-timing-v2` contains committed and uncommitted work and has not been integrated into `main`. The experiment remains unapproved for production activation.

**Size:** Medium–Large because reliable eligibility, control assignment, last-second rechecks, pacing, and ambiguous-send safety matter more than the copy.

### Opportunity

Recover recent guide requests while intent is fresh. The historical campaign showed that a public comment can bring some people back to DM, but old requests were a weak growth lever. The next test should focus on people whose original gate DM was accepted but who showed no later engagement, reminding them within hours rather than weeks.

### Historical evidence

Production attribution checked on 2026-08-16 found:

- 645 unique people received a historical recovery comment.
- 6 later sent an inbound DM, approximately 0.93%.
- 4 returned inside the attribution window and completed the matching keyword flow, approximately 0.62%.
- Among 533 historical control/holdout users with no reminder, 2 returned to DM and 1 completed the matching keyword flow.

These were not clean contemporaneous cohorts, so they do not establish causal lift. They do suggest the largest leak occurs before the person returns: once contacted people returned, 4 of 6 completed the matching flow.

### Recommended smallest experiment

Run one controlled prospective test:

- **Eligible population:** new requests where the original gate DM was accepted and no read, reply, reaction, postback, matching-keyword completion, newer journey, prior recovery, opt-out, or disqualifying safety event is recorded.
- **Timing:** one public reminder 6–12 hours after the request, with the exact delay selected before implementation.
- **Assignment:** deterministic 50% treatment and 50% no-contact control, frozen before any treatment send.
- **Initial treatment copy:** `I sent your guide, but Instagram may have placed it in Requests. DM me [KEYWORD] and I'll send it again.`
- **Pacing:** start at a shared maximum of 10 public reminders per rolling hour unless current campaign health requires less.
- **Primary outcome:** completion of the matching keyword flow within 48 hours of the treatment/control anchor.
- **Secondary outcome:** any inbound DM during the approved attribution window.
- **Safety outcomes:** complaints, blocks, opt-outs, negative replies, deleted/hidden source comments, provider errors, ambiguous sends, authentication/permission failures, and circuit-breaker activity.
- **Evaluation target:** approximately 1,000 eligible people per arm, unless a recalculated sample or an earlier harm, futility, or clear-benefit rule is approved.

### Experiment options

#### A — Timing-only

Use existing reminder copy at a recent delay. This isolates freshness but preserves copy that may not clearly explain Message Requests or the next action.

#### B — Copy-only

Keep current timing and test clearer copy. This isolates wording but may spend the sample after intent has decayed.

#### C — Timely clear copy against control — recommended

Test the smallest complete hypothesis: a prompt reminder with an explicit keyword instruction recovers more matching completions than no reminder. A later test can separate timing from copy if the combined treatment wins.

### Decisions required

- Select 6, 8, 10, or 12 hours.
- Approve exact treatment copy and interpolation rules.
- Enumerate every event that suppresses treatment.
- Decide which merged audience segments are eligible.
- Recalculate whether available volume reaches the target in a useful timeframe.
- Set the minimum absolute lift required to retain the feature.
- Define campaign-level versus shared circuit-breaker events.
- Decide how treatment interacts with other recovery campaigns and capacity.

### Non-negotiable safeguards

- Recheck completion, engagement, comment availability, newer journeys, audience policy, prior recovery, pacing, and circuit state immediately before sending.
- A control participant receives no contact from this experiment.
- One eligible request receives at most one treatment reminder.
- Never automatically retry an ambiguous public-comment result.
- Persist assignment before send and keep exact eligibility evidence.
- Use shared contact capacity and cooldown ledgers; do not create an isolated loophole.
- Do not raise pacing without a separate health review.
- Guide access remains unconditional.

### Acceptance criteria

- Eligibility and every suppression reason are deterministic and testable.
- Assignment is frozen, auditable, balanced, and independent of send outcome.
- Treatment and control share the same anchor and outcome windows.
- The source comment is revalidated immediately before send.
- Duplicate workers and retries cannot produce a second reminder.
- Ambiguous provider outcomes consume the attempt and require review.
- Matching-keyword completion is distinguished from any inbound DM.
- Campaign dashboards show assignment, sent, suppressed, failed, uncertain, completed, inbound, safety, and pacing states.
- Stop, pause, resume, and rollback behavior is documented and tested.

### Dependencies and conflicts

Reuse the shipped prospective recovery primitives and merged audience-segment vocabulary. Coordinate with `GROW-001` because both can influence return/reply outcomes. Do not interpret a simultaneous multi-intervention period as a clean result.

---

## GROW-003 — Apply one shared audience policy to keyword public replies

**Source:** FR-3

**State:** Needs decision. The policy gap is measured. The expanded audience taxonomy is now merged, resolving the source document's branch-order uncertainty but not the product policy.

**Size:** Small–Medium.

### Problem

The recovery system can suppress public reminders for selected audience-origin states, but the much larger keyword auto-reply path has no such check. Both are public comments and therefore carry similar visible reach and brand-distribution consequences.

Measured for the seven days ending 2026-08-09:

| Public-comment path to historically classified South-Asian users | Count |
|---|---:|
| Keyword auto-replies | 924 |
| Recovery reminders | 1 |

The recovery-only flag covered roughly 0.1% of the relevant out-of-market public-comment volume.

### Why this is not a mechanical port

A recovery reminder is an optional re-contact. A keyword acknowledgement responds to a request the person just made. Withholding both the public acknowledgement and the private gate may deny a guide based on audience classification, which is a materially different product and fairness decision.

### Policy options

#### A — Skip only the public acknowledgement — recommended starting point

Continue the private gate DM so guide access is unchanged. Suppress the public comment only when a current, high-confidence policy verdict requires it.

This addresses visible distribution without silently denying the resource.

#### B — Suppress public and private automation

Do not acknowledge or deliver to excluded segments. This is the strongest reach filter and the highest fairness/brand risk. It conflicts with unconditional guide access and is not recommended without a separate explicit policy decision.

#### C — No keyword-path audience gate

Keep recovery filtering isolated. This preserves universal acknowledgement but accepts that the existing policy affects almost none of the relevant volume.

### Latency options

- **Cached verdict, fail open:** read the stored segment; if absent/unknown, send normally and classify later. Recommended for webhook reliability.
- **Classifier on the hot path:** improves immediate coverage but adds latency, availability, and cost to every relevant webhook.
- **Delayed acknowledgement:** queue until classification completes. This changes user experience and webhook/send timing and needs proof it is acceptable.

### Recommended initial policy

- Reuse the merged `audienceSegment` taxonomy and one shared policy function.
- Read a cached verdict in the hot path.
- Suppress only on an explicit, approved excluded segment.
- Fail open for missing, unknown, generic, or unavailable classification.
- Continue the private gate and guide flow.
- Log suppression with the policy version, cached facts, reason, and guide-delivery disposition.

### Decisions required

- Confirm whether guide delivery remains universal.
- Approve which audience segments, if any, suppress the public reply.
- Approve fail-open behavior for unknowns and classifier outages.
- Set the acceptable maximum additional webhook latency.
- Decide whether the old `WESTERN_ONLY` naming is retired in favor of an accurately named cross-path policy.

### Acceptance criteria

- One versioned policy function serves recovery and keyword acknowledgement decisions.
- No second audience taxonomy is introduced.
- Suppression does not silently block the private gate unless explicitly approved.
- Unknown/unavailable classification follows the approved fail behavior.
- Every suppression is countable with reason and policy version.
- Tests cover each audience segment, missing facts, stale facts, classifier failure, duplicate webhooks, and flag rollback.
- Hot-path latency stays within the existing budget when enrichment is unavailable.
- The UI and reports use exclusion language rather than pretending the policy is a complete Western allowlist.

### Measurement

Track suppression volume, private-gate acceptance, reply, guide completion, classification freshness, unknown rate, latency, errors, and any change in audience composition. Do not treat name-based origin inference as precise geography or ethnicity.

---

## GROW-004 — Known-follower gate wording

**Source:** FR-5

**State:** In progress. On `feature/follower-aware-comment-gate`, the focused plan and all three planned implementation commits exist, but the divergent branch has not been rebased, reviewed, or integrated into `main`, and its rollout script has not been authorized with `--write`.

**Size:** Small.

### Problem

The direct-DM keyword path is follower-aware, but the comment path sends the same gate copy to everyone. A known long-time follower can therefore receive wording that says they must follow to unlock the guide.

This is factually wrong and impersonal, although historically it affected only about 0.5% of new conversations in the measured 30-day period.

### Proposed behavior

The branch plan selected this exact private gate when the latest cached `IgUser.isFollower` value is `true`:

> So lovely to see you again 💛 Reply DONE and I’ll send your guide right over.

It also selected this public acknowledgement for newly created automations and an explicit dry-run-first rollout of active stored copy:

> It’s waiting for you 💛 Check your DMs (and Requests)!

Keep the reply step because the person's inbound message is still required to open the messaging window for multi-part delivery.

### Safety boundary

Do not weaken the live follow recheck at reply time. Cached status selects a polite greeting only; live enforcement remains authoritative. The approved branch plan trusts any latest cached `true` regardless of age; `false`, `null`, or lookup failure uses the existing keyword gate. It uses the local database lookup and adds no new Graph API call to the comment hot path.

### Decisions required

- Revalidate the approved literal copy against the current product voice after rebasing.
- Decide whether to preserve the branch plan's age-independent cached-`true` rule or add a later freshness policy.
- Review the dry-run counts before separately authorizing any public-copy database write.

### Acceptance criteria

- Known followers receive approved alternate copy.
- Unknown and known non-followers retain current behavior.
- Live follow enforcement is unchanged and covered by tests.
- No additional Meta request occurs in the comment handler.
- Exact sent gate copy remains auditable.
- Initial private replies and queued retries use the same selected text.
- The public-copy rollout defaults to preview, updates only eligible active rows when explicitly authorized, and is idempotent.

### Priority note

This is a politeness improvement, not a material growth lever. It should not displace `PARENT-001`, `GROW-001`, `GROW-002`, or correctness work.

---

## GROW-005 — Repost and advocacy experiment

**Source:** IA-FR-002

**State:** Candidate. One small positive-feedback prompt concept existed in a stale experiment; no approved product.

**Size:** Small experiment; potentially large platform.

### Opportunity

After a parent clearly expresses that a guide helped, invite one voluntary advocacy action without making the guide transactional. Learn whether a repost, Story share, mention, send-to-a-friend action, or no ask produces authentic reach.

### Product directions

1. **One-time simple ask:** one approved prompt after explicit positive feedback.
2. **Channel experiment:** compare repost, Story share, private recommendation, and no ask.
3. **Advocacy ladder:** recognize repeated verified actions.
4. **Campaign engine:** configure content, timing, variants, caps, rewards, and experiments.

Only the first direction is justified before demand and observability are proven.

### Recommended smallest experiment

- Select one high-volume guide or Reel.
- Define explicit positive feedback with reviewed examples and counterexamples.
- Assign eligible people to treatment and no-ask control.
- Send or owner-approve one ask within a valid messaging window.
- Enforce a strict per-person lifetime or long cooldown cap.
- Track prompt, response, self-reported completion, observable mention/repost where available, negative signals, and aggregate reach direction.
- Offer no reward in the first experiment.

### Decisions required

- Choose one desired action.
- Verify what the current API can actually observe.
- Decide whether Codex may classify feedback, draft the prompt, or only recommend it.
- Approve exact feedback thresholds and copy.
- Set frequency cap and cooldown.
- Decide whether this remains separate from `GROW-007`.

### Risks and safeguards

- A poorly timed ask can damage trust after a helpful interaction.
- Self-report is not verification and must be labeled accordingly.
- Rewards introduce disclosure, fraud, tax, and platform-policy obligations.
- Do not condition guide access or future help on advocacy.
- Medical, distressed, angry, or ambiguous conversations are ineligible.
- Preserve an owner-review boundary until a separately approved narrow automation test succeeds.

### Acceptance criteria for a pilot

- Positive-feedback eligibility is explicit and testable.
- One person receives at most one pilot ask.
- Control receives no ask.
- Observed and self-reported outcomes are separated.
- Negative signals and opt-outs stop future asks.
- Exact text, eligibility evidence, assignment, and outcome remain auditable.
- The result is evaluated against a pre-approved threshold before any campaign engine is designed.

---

## GROW-006 — Broadcast-channel invitation

**Source:** FR-4 and the Circle-invite portion of FR-1

**State:** Needs decision. Destination, copy, and placement require owner input; no implementation exists.

**Size:** Small once channel, link, placement, and copy are approved.

### Opportunity

Guide recipients are warm and currently inside a permitted messaging interaction. Invite them to a recurring destination such as an Instagram Broadcast Channel, if that is the actual product and the link behavior is verified.

Historically the Circle/channel was completely uninstrumented: zero `circle_events` across 1,445 delivered guides. Older recipients whose messaging windows have closed and followers who never messaged are not reachable through a new automated DM; they require a different surface such as Stories.

### Placement options

#### A — Closing-line invitation

Append one invitation to both follower and non-follower closing paths. This is simplest but adds another ask immediately after delivery.

#### B — Age-aware invitation

If `PARENT-001` succeeds, invite after the parent answers, using age/topic context. This is warmer and less immediate but depends on answer rate and later routing.

#### C — Keep existing resource footers only

Make no additional send until evidence shows the current footers are insufficient. Existing footers should not be removed without evidence.

### Required owner inputs

- Is the destination Instagram Broadcast Channel, WhatsApp, Telegram, or something else?
- What is the verified channel link and mobile behavior?
- What exact copy is acceptable?
- Which placement option should be tested?

### Attribution limit

No prior audit found a usable Graph API join for per-user Broadcast Channel membership. Log invitations and variants, record aggregate membership manually, and present the result as correlation. Do not build a per-user conversion dashboard unless a current primary API capability is proven.

### Acceptance criteria

- The destination and link behavior are verified on target devices.
- Both follower-aware delivery paths receive consistent approved behavior.
- Existing resource footers remain unchanged unless a separate decision removes them.
- `circle_invite_sent` or accurately renamed evidence records exact variant and placement.
- UI/reporting states that per-user membership attribution is unavailable.
- Opt-out and message-frequency rules cover this invitation.

### Relationship to PARENT-001

The invitation is separated here so the core age-question experiment can succeed or fail without being confounded by a second ask. If the owner selects age-aware placement, implement it as a later dependent slice rather than bundling it into initial answer-rate measurement.

---

## GROW-007 — Parent ambassador and referral pilot

**Source:** IA-FR-004

**State:** Candidate. No focused design or implementation exists.

**Size:** Medium manual pilot; Large for codes, rewards, fraud controls, and a portal.

### Opportunity

Invite genuinely enthusiastic parents into a transparent, ongoing advocacy relationship and measure one observable outcome.

### Product directions

- **Manual cohort:** owner selects a small group and tracks introductions or outcomes manually.
- **Referral code/link:** attribute a registration, purchase, or other owned conversion.
- **Milestone program:** recognition or rewards at approved thresholds.
- **Ambassador workspace:** applications, status, assets, referrals, rewards, and communications.

### Recommended smallest pilot

Run a manually reviewed cohort with:

- One eligibility rule.
- One clear invitation.
- One verifiable outcome.
- One reward or recognition rule, preferably non-monetary initially.
- One short measurement period.
- Manual fraud/duplicate review.

Do not build a ledger or portal until the pilot produces repeated participation and end-to-end attribution.

### Decisions required

- What outcome counts: owned-site registration, purchase, verified guide request, Circle join, follow, or another event?
- Which outcomes are actually observable?
- Who is eligible and who approves invitations?
- What reward and disclosure language apply?
- How are duplicate identities, self-referrals, fraud, delayed conversion, and unattributed outcomes handled?
- Is this a separate relationship from the low-commitment repost pilot?

### Risks

- Broadcast-channel joins and Instagram follows may not be attributable per person.
- Rewarded endorsements can trigger disclosure and jurisdiction-specific obligations.
- Codes and links can be shared beyond the intended participant.
- A full platform creates accounting and support responsibilities before product value is known.

### Acceptance criteria for a design-ready pilot

- The qualifying outcome is observable end to end.
- Eligibility, reward, disclosure, duplicate, fraud, and dispute rules are written.
- Participation is voluntary and guide access is unaffected.
- The owner controls invitation and payout/recognition decisions.
- The pilot has a stop date and a threshold for expanding, revising, or ending it.

---

## GROW-008 — Context-aware public comment engagement

**Source:** Owner request on 2026-08-20. Related to, but deliberately separate from, the private-DM work in `PARENT-002`.

**State:** Candidate. The opportunity is preserved here; no focused design or implementation is approved.

**Size:** Medium for an owner-reviewed first slice; Large for any narrowly allowlisted automatic public sending.

### Opportunity

When a known follower comments to request a guide, recipe, or other resource, respond publicly in a way that acknowledges an existing relationship, invites a genuine conversation, and accurately tells the person what happened in DM. The intended effect is a warmer public thread, visible evidence that Tiny SOHO cares about repeat followers, and more useful organic engagement.

The owner's example—asking how a follower's toddler is doing with sleep—captures the desired continuity. It also exposes the central safety problem: a fact learned in a private DM may be inappropriate to reveal beneath a public Instagram post.

### Why this is a separate feature

`PARENT-002` assembles private conversation context and drafts private replies. A public comment is visible to the commenter, other followers, search and recommendation surfaces, and potentially the child's wider social circle. Public-context selection, privacy classification, copy, pacing, approval, delivery evidence, and ambiguous-send handling therefore need an independent product boundary. Do not silently reuse the private-DM prompt or publish a private summary.

### Product directions

#### A — Generic deterministic relationship copy

Use follower status and the current request only, for example a warm welcome-back line plus the correct DM status. This is the lowest-risk option but does not demonstrate remembered context.

#### B — Context-aware, owner-reviewed public draft — recommended first slice

Retrieve bounded relationship history, label each candidate fact by provenance and public-safety class, draft one response, run deterministic safety checks, and require the owner to edit or approve before posting. This tests whether contextual replies are useful without granting the model a public send primitive.

#### C — Narrow automatic public response

After owner-reviewed evidence passes explicit privacy and quality thresholds, auto-send only an allowlisted class using public-safe facts. This is a later experiment, not the default V2.

### Recommended context and drafting flow

1. Resolve the commenter to one canonical person and confirm the request is eligible.
2. Retrieve a bounded, newest-first window or reviewed summary of canonical DM and public-thread history. Do not pass an unbounded "entire chat history" to the model.
3. Classify candidate context by provenance:
   - **Public-safe:** the same public thread, another public comment by the person, a generic topic the person has explicitly made public, or a fact with explicit consent for public reuse.
   - **Private-only:** anything learned only in DM, inferred by a model, or not clearly attributable to that person.
4. Supply the drafter only the request, approved voice rules, delivery status, and public-safe context. Keep private-only facts out of the public prompt.
5. Produce a structured draft with the acknowledgement, optional low-sensitivity question, DM-status clause, cited context provenance, and safety decision.
6. Recheck new inbound activity, duplicate/public-reply state, source-comment availability, cooldown, pacing, and actual DM delivery evidence immediately before posting.
7. Record the exact approved text, context evidence IDs, model/prompt version, owner action, provider result, and later engagement outcome.

### Public copy rules

- Acknowledge the requested guide, recipe, or topic in plain language.
- Ask at most one optional, low-sensitivity, open question when there is safe public context.
- Say **"I sent the guide in your DMs"** only after provider-accepted guide delivery is recorded.
- If only the gate/private reply was accepted and the person still needs to reply, use accurate copy such as **"Check your DMs (and Requests) to continue."**
- Do not reveal a child's name, exact age, diagnosis, development, sleep or feeding struggle, health information, family circumstances, location, private emotional disclosure, or any other DM-only fact.
- Do not imply that the owner personally remembered, reviewed, or wrote the reply unless that is true.
- Use a generic deterministic response when no safe contextual fact exists; absence of context is not an error.

### Smallest useful experiment

Start in shadow or owner-reviewed mode for one or two guide topics and 50–100 eligible comments:

- Preserve the current deterministic public acknowledgement as the control/reference.
- Generate contextual drafts without automatically posting them.
- Let the owner approve, edit, replace with generic copy, or dismiss.
- Record why context was rejected, especially privacy, staleness, awkwardness, factual error, and wrong delivery status.
- Advance to public posting only for individually approved drafts.
- Do not start during a `GROW-001` public-copy experiment unless assignment and analysis can isolate both interventions.

### Decisions required before focused design

- Is V2 strictly owner-reviewed, or may any class auto-send after evidence? The recommended first answer is owner-reviewed.
- Are eligible people known followers only, repeat guide requesters, or any resolved person with history?
- Which fact provenances are public-safe, and can a person grant or withdraw consent for public reuse?
- How much recent history is necessary, and when is a summary invalidated?
- Should the public reply happen on the initial request, only after actual guide delivery, or at another event?
- What cooldown and lifetime cap prevent repeated personalized public comments from feeling invasive?
- Which question categories are allowed or prohibited?
- What owner-review sample, approval rate, edit rate, privacy-rejection rate, and harm threshold permit expansion?
- Should AI assistance be disclosed in the owner workflow, the public copy, or both?

### Measurement

- Draft approval, edit, generic-replacement, and dismissal rates.
- Context rejection by reason and provenance.
- Public reply rate, thread depth, later DM activity, and matching guide completion.
- Owner time per approved public response.
- Hidden/deleted comments, negative replies, opt-outs, complaints, blocks, and privacy incidents.
- Delivery-status accuracy: guide-confirmed, gate-only, failed, or uncertain.
- Incremental engagement versus an uncontaminated deterministic reference, with denominators and uncertainty.

### Non-negotiable constraints

- Private-only history never appears in a public prompt or public response without explicit, auditable consent for that exact use.
- Never diagnose medical, developmental, or psychological conditions.
- Never claim guide delivery before provider-accepted guide delivery evidence exists.
- A new inbound message or changed delivery state invalidates a stale draft.
- One event produces at most one public response; ambiguous provider outcomes are never automatically retried.
- Shared public-contact pacing, cooldowns, capacity limits, opt-outs, and circuit breakers apply.
- Credentials and the public send primitive remain outside the isolated drafting runtime.
- Exact text, evidence, approval, send result, and deletion/complaint outcomes remain auditable.

### Design-ready evidence

- The public/private context boundary is expressed as deterministic rules with positive and negative examples.
- At least 50–100 shadow or owner-reviewed cases establish approval, edits, privacy rejection, and delivery-status accuracy.
- Current Meta comment and messaging behavior is verified from primary documentation and observed provider responses.
- The eligible cohort, context bound, timing, copy schema, owner boundary, caps, stop rules, rollback, and monitoring are explicit.
- `REL-001` can reconstruct the context and send evidence without exposing private data in ordinary public-facing UI.

### Dependencies and conflicts

- `REL-001` for a complete canonical history and public-versus-private audit trail.
- `PARENT-002` for safe context assembly and owner-review evidence, without reusing its private prompt directly.
- `GROW-004` for reliable known-follower selection when eligibility depends on follower state.
- `GROW-003` for the shared audience policy and public-contact decision.
- Shared idempotent public dispatch, pacing, cooldown, and ambiguous-send controls.
- `GROW-001` and `GROW-002` can confound engagement and completion outcomes if run on the same cohort.

---

# Reliability and operational correctness

## REL-001 — Complete the person timeline

**Source:** FR-2a

**State:** Candidate. This is a confirmed correctness bug and was still present on `main` in the 2026-08-20 audit.

**Size:** Small–Medium.

### Problem

The person view claims to reconstruct what the automation saw and sent, but it omits important activity through two independent failures.

First, `/users/:igUserId/lineage` reads `Conversation` and `EventLog` but does not query `DmMessage`. A successful owner-approved AI send is recorded as a `DmMessage` and may have no success event. Such a message can therefore be completely absent from the person view.

Second, `UserLineage.tsx` renders chat bubbles only for a small hard-coded set of user and bot event kinds. Historically the backend emitted at least 66 literal event kinds, while `BOT_KINDS` included only four. Recovery events, AI failure/uncertain events, gate failures, historical-recovery events, and other meaningful actions fall out of the conversation display. Many are visible only in the raw timeline with weak labels; some are not presented with their real channel.

### Important correction from the source audit

- `ai_reply_sent` is not an event kind. Successful AI sends live in `DmMessage`.
- `send_no_confirmed_read_reminder` is a recovery trigger enum, not an event-log kind.
- Recovery sends are recorded as `dm_recovery_sent`, `dm_recovery_sent_late`, or `dm_recovery_suppressed`.

The bug is broader than two missing labels: the backend omits a data source and the frontend silently excludes most event categories.

### Why this is urgent

The moment AI sending is enabled, a parent can receive an AI-written DM that the owner's person view does not display. This undermines auditability precisely when the system begins taking higher-risk actions.

### Proposed scope

1. Extend the lineage endpoint to fetch relevant `DmMessage` rows and merge them chronologically with event-log rows.
2. Preserve direction, message type, source, delivery identifiers, and whether the message came from an approved AI draft.
3. Define a deterministic deduplication rule where an event and a `DmMessage` represent the same send.
4. Replace the narrow bot allowlist with an exhaustive classification: `thread bubble`, `timeline only`, or `hidden with reason`.
5. Make new event kinds visible by default during development, or fail a contract test, rather than silently hiding them.
6. Add human-readable labels for every event kind exposed to the UI.
7. Render public recovery comments distinctly from DMs.
8. Move the shared `EventRow` component out of the Conversations page so `UserLineage` does not import from a page module.

### Decisions required

- What constitutes the stable deduplication key: provider message ID, source event ID, approved draft ID, or a documented composite fallback?
- Which system-only events are useful in the full timeline but too noisy for the chat thread?
- Should uncertain and failed sends appear inline in the thread, in the timeline, or both?

### Acceptance criteria

- A successful AI-originated `DmMessage` appears in the person's chronological thread.
- Recovery public comments appear with a public-comment affordance, not as DM bubbles.
- Every backend event kind has an explicit UI classification and, when visible, a readable label.
- A test fails when a new literal `logEvent` kind lacks classification or labeling.
- Duplicate records representing one send render once without losing evidence.
- Manual Instagram replies that the system cannot observe remain explicitly disclosed as absent.
- No component imports a shared row renderer from a page module.

### Verification

- Run backend tests and build.
- Run web tests and production build with the required environment.
- In production data, inspect a person with `dm_recovery_sent` and confirm correct channel rendering.
- After a controlled, owner-approved AI send exists, inspect a `DmMessage`-only success case.
- Compare merged ordering around a guide sequence, closing line, owner-approved reply, and recovery comment.

### Dependencies and sequencing

Do this before enabling AI sending and before the full Conversations redesign. `REL-004` should consume the corrected person timeline rather than invent another partial history.

---

## REL-002 — Replace Spike Candidates with recent reach share

**Source:** CT-2

**State:** Candidate. This is a confirmed analytics defect with a substantially worked design; no implementation was found.

**Size:** Medium.

### Problem

The current Spike Candidates panel can look static because the candidate-ranking code drops a Reel when it lacks a pre-window snapshot. New Reels are precisely the items most likely to lack that earlier baseline, so the current algorithm systematically hides much of the content driving recent reach.

Measured on 2026-08-03:

- 12 Reels were dropped.
- Those Reels accounted for 44,915 of 65,469 recent reach, or about 69%.
- The resulting top candidates were old back-catalog content while new content was invisible.
- Reels 0–7 days old accounted for 76.7% of window reach.

### Root cause and correction

For a Reel posted inside the analysis window, the correct pre-window baseline is definitionally zero. Add `postedAt` to the ranking facts and use a zero baseline when `postedAt` falls within the window. Retain a documented fallback for nullable timestamps even though the historical audit found zero null `postedAt` values and zero orphan snapshots.

### Product reframing

Replace spike attribution with a rolling answer to: **What content contributed to reach during the last seven days?**

The panel should not claim causation or precise follower attribution. It should show recent reach contribution.

### Headline rule

Use `Last 7 days · N/day` with no prior-seven-day comparison.

The prior-window comparison can be misleading when one spike day contaminates the baseline. In the historical example, the current period was the account's strongest sustained run, yet a prior period containing two unusual days would have made it look like a decline. The existing 7-day versus 28-day trend badge is the more stable context and should remain the single trend comparison.

### Data ownership

- Keep the daily follower rate client-side through the existing `summarizeFollowerFlow(points).avgPerDay7` calculation so the panel and adjacent legend cannot disagree.
- Compute Reel reach shares server-side from performance snapshots.

### Proposed data contract

```ts
export interface ReachShareEntry {
  mediaId: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  postedAt: string | null;
  reachGained: number;
  sharePct: number;
}

export interface WhatsWorkingInfo {
  windowStart: string;
  windowEnd: string;
  top: ReachShareEntry[];
  residualPct: number;
  residualReelCount: number;
  totalReachGained: number;
}
```

Remove the per-point `spike` payload and the duplicate `SpikeInfo`/`SpikeCandidateInfo` declarations after all consumers migrate.

### File-direction recommendation

- Rename `spikeCore.ts` to `reachShareCore.ts`.
- Retain and correct candidate ranking.
- Remove spike-detection constants and helpers that no longer describe the product.
- Rename `spikeService.ts` to `reachShareService.ts` and use one rolling window with a fixed query shape.
- Replace `SpikeCandidates` with a recent-contribution component.
- Do not add more unrelated logic to the already-large follower-flow helper.

### Historical expected result

Measured for the seven-day period ending 2026-08-03:

| Rank | Reel | Share | Reach gained |
|---|---|---:|---:|
| 1 | Bedtime with a toddler is never just bedtime | 21% | 13.9K |
| 2 | Most parents spend weeks… | 13% | 8.7K |
| 3 | The mistake isn't using a pacifier… | 11% | 7.2K |
| — | 92 other Reels | 55% | Remaining reach |

Top three accounted for about 45.5%; residual was about 54.5%.

### Residual rule

Use every Reel with positive in-window gain as the denominator and residual count. Do not apply an arbitrary floor merely to shorten the tail. A floor makes the count look cleaner while breaking reconciliation between the displayed shares and the stated number of remaining Reels.

### Decisions required

- Confirm seven calendar days as the fixed initial window.
- Decide whether the UI title should be `What's working`, `Recent reach contribution`, or another non-causal label.
- Decide whether the top list remains three items on desktop and mobile.

### Acceptance criteria

- A Reel posted during the window uses a zero pre-window baseline.
- New Reels are not dropped solely because no older snapshot exists.
- Top shares plus residual reconcile to the total within documented rounding.
- The residual count uses the same positive-gain population as the residual percentage.
- No prior-seven-day comparison appears in the headline.
- The displayed daily rate uses the same calculation as the follower-flow legend.
- Tests cover in-window posting, missing timestamps, negative/noisy deltas, rounding, and no-positive-gain states.
- The UI uses contribution language and never implies exact follow attribution.

### Verification

Re-run snapshot coverage and the historical ranking against current production data. Compare the old and new top-three lists for several windows, including a week with newly published Reels. Confirm that deletions, missing snapshots, and null timestamps fail safely.

### Relationship to INSIGHT-006

`REL-002` answers which content contributed to a recent rolling window. `INSIGHT-006` answers which content has the strongest cumulative lifetime values. They are complementary, not duplicates, and their labels must keep the time bases unmistakable.

---

## REL-003 — Harden and shadow-verify caregiver-aware AI replies

**Source:** FR-7 and the shipped-foundation portion of IA-FR-001

**State:** Needs decision. The shadow-drafting foundation is shipped and production sending remains disabled. Activation requires engineering work for reply timing, cold-draft expiry, caregiver-aware voice, deterministic style checks, and complete auditability, followed by owner shadow review.

**Size:** Small–Medium engineering plus operational review.

### Existing capability

The merged system can:

- Capture cold inbound DMs that match no keyword or open gate.
- Queue structured Codex reply drafts for owner review.
- Schedule one post-guide engagement follow-up draft.
- Cancel or expire follow-ups based on later activity and messaging-window rules.
- Let the owner edit, regenerate, dismiss, approve, and send where sending is enabled.
- Keep the Codex runtime separated from Instagram credentials and direct send primitives.

No AI message sends itself under the approved baseline.

### Current gate

The deployment runbook requires a ten-step shadow verification and explicitly stops for owner approval before setting `AI_SEND_ENABLED=true`. Enabling the flag and authorizing the first real AI-approved DM are separate decisions.

Because the UI disables approval when `sendEnabled` is false, shadow drafts are not actionable queue items. This directly affects the design timing of `REL-004`.

### Mandatory natural-timing requirement

AI-assisted replies must not be delivered immediately after an inbound message. The purpose is natural conversational pacing and avoiding uncanny machine-speed behavior, not defeating AI detectors or pretending that an unreviewed message was personally typed.

Use the following timing contract:

1. Start the clock from the Meta timestamp of the latest inbound Instagram message, not from draft generation or owner approval.
2. Choose a random delay from 120 through 300 seconds and persist the selected value once. Retries, worker restarts, and duplicate webhook deliveries must not choose a new delay.
3. Draft generation may begin immediately so the owner has the full review window.
4. Delivery must be impossible before the persisted `notBefore` timestamp, including through concurrent approvals or a direct API call.
5. If the owner approves before `notBefore`, hold the approved draft in a visible scheduled state. If the owner approves after `notBefore`, it may proceed immediately without adding another artificial delay.
6. A newer inbound message supersedes the draft, cancels its scheduled send, and creates a new timing decision from the newer inbound timestamp.
7. The owner must be able to see the scheduled time and cancel the send before delivery.
8. Owner approval remains mandatory. The delay does not authorize automatic sending.
9. The delay never overrides messaging-window expiry, opt-out, latest-inbound, prompt-version, or kill-switch checks.
10. Manual messages written and sent independently by the owner are outside this artificial-delay requirement.

The schedule should use a dedicated persisted boundary such as `notBefore`; do not overload an ambiguous creation timestamp. The approval and final-send boundaries must both enforce the same value using the database clock.

### Tiny SOHO reply voice policy

The generic production instruction, `Warm, practical, concise, and supportive. Never diagnose or shame a parent.`, is necessary but not sufficient. Every AI-assisted cold reply and engagement follow-up must use a versioned Tiny SOHO voice policy with these rules.

#### Message shape

- Write one to three short sentences.
- Respond directly to the specific inbound message; do not begin with throat-clearing.
- Ask at most one easy question.
- Prefer plain words, contractions, and active voice.
- Do not use headings, bullet lists, numbered lists, formal greetings, or formal sign-offs in an ordinary DM.
- Use no more than one contextually appropriate emoji. Do not add an emoji when the message is serious, distressed, hostile, or safety-sensitive.
- Match the language used by the participant only when the system can do so confidently and safely. Otherwise use clear, simple English rather than inventing slang or a partial translation.
- Keep the existing hard character limit, but treat it as a safety ceiling rather than a target. Normal replies should be much shorter.

#### Punctuation and AI-pattern rules

- Do not produce an em dash (`—`) or en dash (`–`).
- Do not use a double hyphen (`--`) as sentence punctuation.
- Avoid stacked parentheses, semicolons, excessive exclamation marks, and repeated ellipses.
- Avoid generic affirmation openers such as `Great question`, `Absolutely`, `Certainly`, or `You're completely right`.
- Avoid stock AI phrases such as `It is important to note`, `Let's dive in`, `Here's the thing`, `At the end of the day`, and `I hope this helps`.
- Never say `as an AI` or discuss the drafting system in the customer-facing reply.
- Do not force a rule of three, manufacture a punchline, add a generic positive conclusion, or restate the same advice in different words.
- Do not deliberately add misspellings, grammar errors, random slang, fake fragments, or inconsistent punctuation to imitate a human.

These are product voice requirements, not an AI-detector score. Clear, faithful writing outranks mechanical synonym replacement or forced irregularity.

#### Truthfulness and safety

- Preserve the meaning of the conversation and any approved source material.
- Never invent a fact, name, age, relationship, diagnosis, result, personal story, or prior interaction.
- Never claim first-person parenting experience, such as `I went through this with my child`, unless the owner personally wrote and approved that exact claim for the specific reply.
- Never diagnose a medical, developmental, or psychological condition.
- Do not promise an outcome, guarantee a developmental timeline, shame a caregiver, use guilt, or create urgency.
- When context is missing, an attachment cannot be understood, or the question needs professional judgment, say so modestly and surface a warning for the owner instead of guessing.
- A style pass must never weaken uncertainty, safety language, or factual boundaries merely to make the reply sound livelier.

### Caregiver-aware relationship language

Do not assume that the participant is a mother, father, or parent. Relationship language may come only from explicit evidence in the retained conversation or an owner-confirmed profile field. A name, username, photo, inferred gender, or audience segment is not relationship evidence.

Use these rules:

| Known relationship | Preferred language | Prohibited assumption |
|---|---|---|
| Parent | `your child`, `your little one`, or the parent's own term | Do not infer mother versus father or use `Mom`/`Dad` without explicit evidence |
| Nanny or professional caregiver | `the child you care for` or the person's own term | Do not call the child theirs or imply final parental/medical authority |
| Grandparent | `your grandchild` or the grandparent's own term | Do not assume they are the primary caregiver or decision-maker |
| Other relative | Reuse the explicit relationship, such as `your niece` | Do not upgrade the relationship to parent or guardian |
| Unknown | Reuse the participant's noun, such as `the toddler`, or use `the little one you're asking about` | Do not guess a family relationship |
| Multiple children or ambiguous reference | Ask which child or age they mean when that distinction matters | Do not silently select one child |

Do not open with `Mom`, `Mama`, `Dad`, `Grandma`, `Grandpa`, `Nanny`, or a similar label unless the person explicitly used and welcomed it. The safest default is to address the situation rather than label the adult.

### Voice calibration from real owner replies

Create a compact, reusable Tiny SOHO voice profile from approximately 20 to 50 owner-written or owner-approved Instagram replies. Prefer recent private DMs that the owner considers successful.

The calibration process must:

- Remove or replace participant identifiers and unnecessary family details before examples become durable prompt or test material.
- Separate public-caption voice from private-DM voice; they are not interchangeable.
- Record sentence length, vocabulary, contraction use, warmth, question style, emoji frequency, and phrases the owner avoids.
- Include examples for parents, nannies/caregivers, grandparents, unknown relationships, complaints, ambiguous questions, unsupported attachments, and safety-sensitive topics.
- Preserve intentional Tiny SOHO phrasing rather than making every reply uniformly polished.
- Store the confirmed profile in version-controlled application policy. Do not rely only on a mutable environment variable.
- Require owner approval before changing the durable voice profile.

### GitHub research basis and adoption boundary

The requirements above draw selected, reviewable principles from these public projects:

- [`blader/humanizer`](https://github.com/blader/humanizer): no fabrication, voice calibration, restraint, and common AI-writing patterns.
- [`hannsxpeter/humanizer`](https://github.com/hannsxpeter/humanizer): faithfulness, meaning checks, and avoiding unnecessary rewrites.
- [`Shirhussain/humanize`](https://github.com/Shirhussain/humanize): register-aware rules, deterministic linting, and tests.
- [`tw93/Waza` write skill](https://github.com/tw93/Waza/blob/main/skills/write/SKILL.md): author voice, meaning preservation, and a deterministic punctuation gate.
- [`affaan-m/ECC` brand-voice skill](https://github.com/affaan-m/ECC/blob/main/.agents/skills/brand-voice/SKILL.md): deriving a reusable voice profile from real examples.

Do not fetch or execute a mutable GitHub skill at reply time. Do not install a complete long-form humanizer as an opaque production dependency. If exact third-party text or code is copied, pin the reviewed revision, retain required license attribution, and vendor only the smallest relevant portion. The application-owned policy and tests remain the production source of truth.

### Deterministic validation gate

Prompt instructions alone are insufficient for hard product rules. Before a generated draft becomes reviewable, run an application-owned deterministic validator that reports stable rule identifiers.

At minimum, validate:

- Em dashes, en dashes, and double-hyphen sentence punctuation.
- Empty, over-limit, or unexpectedly long replies.
- Sentence count and question count.
- Excessive emojis, exclamation marks, or ellipses.
- Prohibited generic and AI-style phrases.
- Explicit relationship labels that lack retained evidence.
- Claims of first-person parenting experience.
- High-risk diagnostic, guaranteed-outcome, guilt, shame, or urgency language.
- Whether the response acknowledges a concrete part of the latest inbound message rather than returning a generic answer.

Safe deterministic punctuation cleanup may produce a new draft revision. Semantic findings must not be silently rewritten. They should block the draft or add a clear owner warning and require regeneration or manual editing. Store validator version, findings, and the exact prompt/voice version with the draft.

### Prompt version and rollout

Implement these requirements as a new prompt-policy version. Existing version-2 drafts must remain historically visible but cannot be approved under the new policy. Regeneration creates a new revision using the new prompt, voice, timing, and validator versions.

Before any send activation, evaluate an anonymized corpus of at least 50 representative transcripts spanning ordinary questions, ambiguous context, attachments, each caregiver relationship, multiple children, complaints, multilingual messages, prompt injection, opt-out, and safety-sensitive topics.

The activation gate requires:

- Zero critical safety failures, fabricated facts, or unsupported relationship assumptions.
- A 100% pass rate for deterministic punctuation and timing boundaries.
- No test case that sends or schedules without owner approval.
- At least 90% of drafts passing the written style rules without regeneration.
- At least 80% judged useful by the owner with no more than light editing.
- Documented examples of rejected, regenerated, edited, expired, superseded, scheduled, cancelled, failed, and uncertain outcomes.
- An explicit owner go/no-go decision recorded after reviewing the results.

### Required action

Run the shadow checklist in `DEPLOY.md` in order. Collect:

- Draft creation success and latency.
- Draft relevance and factuality.
- Natural 2-to-5-minute scheduling and cancellation behavior.
- Punctuation, AI-pattern, caregiver-role, and Tiny SOHO voice validation.
- Approval, edit, regeneration, and dismissal candidates.
- Medical/developmental, hostility, unsupported-media, prompt-injection, opt-out, and uncertainty classifications.
- Window expiration behavior.
- Runtime failures and recovery.
- Audit completeness in the person timeline.

Stop at the owner-approval gate. Do not enable sending as part of the audit.

### Owner decisions after the audit

- Is draft quality sufficient to make owner-approved sending useful?
- Which message categories remain prohibited even with review?
- Does the calibrated voice sound like the owner without adding fake mistakes or unsupported familiarity?
- Are the timing delay and scheduled-send controls operationally understandable?
- Is the operational burden lower than replying manually?
- Is `REL-001` complete enough to audit the first send?
- Should follow-up drafting remain disabled, enter shadow mode, or progress separately from cold-DM drafting?

### Acceptance criteria for the shadow phase

- The exact deployed flag values are recorded from the running environment, not inferred from `.env.example`.
- Representative drafts exist for ordinary, ambiguous, unsafe, and unsupported inputs.
- Representative drafts cover parent, nanny/caregiver, grandparent, other-relative, unknown, and multiple-child cases.
- No outbound AI message is sent.
- Every candidate passes the versioned deterministic gate or is visibly blocked with stable findings.
- The persisted 2-to-5-minute timing boundary is enforced at approval and immediately before send.
- Every draft and runtime decision has sufficient evidence for owner review.
- Failures and expired windows produce safe, understandable states.
- Results are summarized for an explicit go/no-go decision.

### Rollback boundary

The documented rollback remains disabling drafts, follow-ups, sending, and advisor capability, followed by redeployment. Preserve this kill-switch behavior in all future Copilot work.

### Dependencies

Complete `REL-001` before the first real send. Use shadow findings to design real queue rows for `REL-004`. Any move beyond owner-approved sending belongs to `PARENT-002` and requires a new focused design.

---

## REL-004 — Rebuild Conversations as one actionable queue and one person view

**Sources:** FR-2 and CT-3. CT-3 is fully absorbed here.

**State:** Candidate. Four historical mockups and worked behavior rules exist; there is no approved spec or implementation.

**Size:** Medium–Large. Split into two releases.

### Problem

The Conversations page uses visually similar pills for two different concepts: switching among object types and filtering one object type. Some filters also switch modes implicitly. The recovery lens adds another pill row, producing a crowded control surface.

The deeper mismatch is conceptual. The page is a collection of object browsers—drafts, DMs, automation journeys, and recovery reminders—while the owner thinks in people and asks: **Who needs me, and what happened with this person?**

Historically the page held four lenses, four drawers, and three queries in one large file. The existing person view was stale and buried under a separate Users navigation item.

### Observed owner workflow

The desired rhythm is one scan followed by one drill-in. More top-level lists increase scanning work. The design goal is fewer lists and a deeper, complete person view.

### Product options considered

#### Option A — One queue, one complete person view — recommended

Merge actionable states from drafts, threads, journeys, and recovery. Show one row per person with badges explaining why they surfaced. Open the corrected person timeline for the whole story. Retain user search as a secondary path.

#### Option B — Person directory first

Merge Conversations and Users into one people table with columns and filters. This is conceptually clean but makes queue work secondary and expands scope substantially.

#### Option C — Minimal control cleanup

Use a real segmented control for mode and a separate dropdown/filter for journey state. Stop filters from secretly changing lenses. This is useful but does not solve repeated scanning.

### Recommended two-release shape

**Release 1:** Implement Option C's control clarity, extract shared components, and complete `REL-001`.

**Release 2:** Implement Option A's merged queue after real shadow drafts provide observed content and timing.

### Definition of “Needs you”

Use this test: **If the owner went away for a week, would the state resolve itself?** If yes, it is not an owner task.

Include:

| State | Source | Reason |
|---|---|---|
| `pending_approval` | AI draft | Only a human can approve, edit, or dismiss |
| `needsReply` with no viable draft | Thread | A meaningful inbound message remains unanswered |
| `send_failed` | Draft | Retrying requires a judgment |
| `send_uncertain` | Draft | It may already have sent; a human must inspect Instagram |
| `send_failed`, `send_uncertain`, `tracking_unavailable` | Recovery | A human decision is required |

Exclude:

- `drafting`
- `awaiting_done`
- `retrying`
- `scheduled`
- `control`
- `suppressed`
- `completed`
- `replied`
- Any draft that cannot be approved because AI sending is disabled

Reuse the recovery view model's existing `NEEDS_REVIEW` logic. Do not create a second interpretation.

### One row per person

Each row should answer:

- Who is the person?
- Why are they in the queue?
- What is the highest-priority action?
- How much time remains before the action expires?
- Are there multiple reasons requiring attention?
- What was the last meaningful inbound or outbound activity?

Multiple object records for the same person must consolidate into badges or a priority summary, not duplicate rows.

### Sort decision that remains open

The post-guide follow-up becomes eligible after 12 hours and expires before the 24-hour messaging-window limit, leaving roughly 11.5 actionable hours under ideal delivery timing. Evening activity may become un-actionable before a once-daily morning review.

The owner must answer: **Will this admin normally be checked more than once per day, or approximately once each morning?**

- Frequent review may favor severity and recency.
- Once-daily review likely requires remaining legal window as the primary sort because delay permanently destroys the action.

### Decisions required

- Owner review cadence and therefore default sort.
- Whether the queue initially shows only `Needs you` or supports `Everything`, `Needs you`, and `Stuck`.
- How multiple reasons on one person determine the primary action.
- Whether user search stays in the Users page, moves into Conversations, or links both routes to the same drawer.

### Acceptance criteria

- One row represents one person across drafts, threads, journeys, and recovery.
- Badges identify every reason the person surfaced.
- Queue inclusion follows the documented human-decision test.
- Unapprovable drafts are excluded without a fake action state.
- Recovery review logic is reused.
- The default sort matches the owner's stated review cadence.
- Clicking a row opens the complete corrected person history from `REL-001`.
- Mode controls and filters are visually and behaviorally distinct.
- Shared components do not import from page modules.
- Empty, loading, partial-failure, and stale-data states are explicit.

### Dependencies

- `REL-001` is a hard prerequisite for trustworthy drill-in.
- `REL-003` should produce real shadow examples before Release 2 is finalized.
- Coordinate with any active work that changes guide delivery, draft statuses, or recovery state vocabulary.

---

## REL-005 — Apply or explicitly decline journey reconciliation

**Source:** “Pending production action” in the near-term backlog.

**State:** Needs decision. The code is shipped, but historical data remains unchanged until a reviewed write is approved and run.

**Size:** Operational.

### Context

Journey reconciliation code was deployed but deliberately does not mutate production until the owner authorizes a script run with `--write`.

The historical dry run reported:

```text
canonical intents 4,529
confirmed_gate 2,458
completed 1,969
earliest 102
skipped live journey 350
aliases recovered 284
superseded 58
```

Those numbers are stale and must be regenerated.

### Required decision

Re-run the dry run against current production, review the exact mutation categories and live-journey exclusions, then explicitly choose one:

- Approve the production write.
- Request narrower criteria and another dry run.
- Decline reconciliation and record why the historical inconsistency is acceptable.

### Acceptance criteria

- Current dry-run counts and representative examples are reviewed.
- The script remains idempotent and excludes live journeys.
- A backup or recoverable evidence set exists before mutation.
- The owner explicitly authorizes `--write`.
- Post-write counts reconcile to the approved preview.
- The outcome and timestamp are recorded so future audits do not repeatedly flag this action.

---

## REL-006 — Explicit sequence-editor saves

**Source:** Approved design and implementation plan dated 2026-08-09 on `feature/guide-message-delivery`.

**State:** In progress. The feature is implemented and tested on the divergent `feature/guide-message-delivery` branch but absent from `main`. Treat this as integration work, not shipped behavior and not a request to implement the feature again from scratch.

**Size:** Integration and current-baseline validation. The original implementation was a focused frontend change with no backend, schema, or API-contract change.

### Goal

Make it obvious and deliberate when authored sequence text is persisted. An author should never need to infer whether a pasted or edited guide message was saved.

### Approved behavior

- Sequence name, internal note, message bodies, and captions remain local drafts until **Save changes** or `Cmd+S`/`Ctrl+S`.
- Adding, deleting, reordering, and uploading remain immediate structural actions.
- Status is explicit: **All changes saved**, **Unsaved changes**, **Saving…**, **Couldn't save — retry**, or **Needs attention — message too long**.
- Leaving through app navigation, browser history, reload, or tab close while dirty or saving produces an unsaved-changes warning.
- A failed save preserves the local draft for retry.
- A successful field advances only to the submitted snapshot; newer typing during an in-flight save remains dirty.
- The shared 1,000 UTF-16-unit Instagram guide-message limit remains authoritative.
- A multi-request partial success advances successful baselines and retries only failed dirty fields.

### Existing branch evidence

- Approved design: `docs/superpowers/specs/2026-08-09-sequence-editor-explicit-save-design.md` on the branch.
- Implementation plan: `docs/superpowers/plans/2026-08-09-sequence-editor-explicit-save.md` on the branch.
- `2a831be` adds the unsaved-navigation guard and data-router support.
- `4231cb3` adds explicit authored-text saving and focused tests.

The branch also contains extensive unrelated and later work. Do not merge it wholesale merely to obtain these two commits.

### Required integration work

1. Compare the two focused commits and their prerequisite design/plan against current `main` after the interface migrations.
2. Choose a narrow rebase, cherry-pick, or manual port that preserves current router, editor, and save-status behavior.
3. Bring the design and implementation plan onto `main` with the integration so future readers can trace the approved behavior.
4. Re-run the focused editor and navigation tests, full web tests, lint, and a production build with required environment.
5. Perform visual and interaction QA for clean, dirty, saving, over-limit, failed, partial-success, and leave-confirmation states.

### Acceptance criteria

- Editing or blurring authored text performs no implicit PATCH.
- Save submits only dirty resource/message fields.
- Clean, in-flight, blank-name, and over-limit states disable Save appropriately.
- The keyboard shortcut invokes the same save path.
- Failed and partial saves preserve exactly the remaining dirty drafts and allow retry.
- Edits made during an in-flight save remain dirty after the earlier snapshot succeeds.
- In-app and browser-level navigation are guarded only while dirty or saving.
- Structural actions retain their immediate behavior.
- The current `main` route tree and unrelated interface behavior do not regress.
- The behavior is not marked `Shipped` until the focused integration is established on `main`.

### Dependencies and conflicts

This feature depends on the current sequence editor, save-status component, shared message-length policy, and router architecture. It may conflict with later interface migrations on `main`; resolve those conflicts deliberately instead of reverting newer UI work.

---

# Parent value and retention

## PARENT-001 — Age-aware parent profile and next-resource loop

**Sources:** FR-1 and IA-FR-012. FR-1 is the controlling detailed version; IA-FR-012's broader options are retained here.

**State:** Needs decision. A historical design was approved on 2026-08-04, but no matching participant fields, age question, parser, candidate routing, or invite evidence was found on `main`. Revalidate the old approval before planning because the surrounding system has changed.

**Size:** Large. Build and evaluate in slices.

### Business problem

Guide delivery is usually a one-time transaction. Measured on 2026-08-04:

| Behavior | People | Share |
|---|---:|---:|
| Completed exactly one keyword flow | 1,203 of 1,266 | 95% |
| Completed two or more keyword flows | 63 of 1,266 | 5% |

The keyword reflects which Reel a parent encountered, not necessarily the most important challenge in the household. Historical delivery volume was heavily concentrated—`SLEEP` was delivered 747 times while `PICKY` was delivered 6—without proving that sleep was the only or primary need.

A second leak was approximately 673 `message_unhandled` events, around seven per day: parents sent substantive text and received no useful next step.

### Existing foundation

The resource library already supports structured retrieval:

- `Resource.kind`
- `Resource.theme`
- `Resource.ageMinMonths`
- `Resource.ageMaxMonths`
- `ResourceMessage.altText` for image-based guide pages
- An index over theme and age range

The foundation makes reviewed guide content machine-readable. It does not yet create a parent profile or recommendation loop.

### Product question

After delivering requested value, can one optional, low-friction question reveal enough context to offer a genuinely relevant existing resource and create a useful second interaction?

### Question options

#### A — Exact age — historically selected

Ask: `How old is your little one? 🤍` and normalize months where confidence is high.

Advantages: supports existing month-range metadata and content-gap analysis.

Costs: parsing is complex; multiple children, changed ages, pregnancy, and indirect numbers require careful handling.

#### B — Age-band choice

Offer a few broad ranges. Easier to parse and less precise, but interactive-choice delivery and messaging-window behavior must be verified.

#### C — Need-first question

Ask what the parent is struggling with. This may be more directly useful but requires intent classification and a safe no-match path.

#### D — Passive extraction only

Do not proactively ask. Extract age or needs only from voluntarily supplied text and keep the next action owner-reviewed.

### Recommended staged design

Retain the historically selected exact-age question for a controlled first test, but split learning from routing. Slices A and B test whether parents answer and whether answers can be parsed safely. Do not build the general next-resource loop until the answer-rate and parse-quality thresholds are met.

## PARENT-001 Slice A — Ask one optional question

Ask after the guide, never before it. Delivery is the proven value event and must remain unconditional.

Merge the question into the existing follower-aware closing line so it does not create another message:

```text
Known follower:
Thanks for following! 💛 How old is your little one? 🤍

Not known as follower:
Follow @tinysoho so you don't miss the next one 🙏
And how old is your little one? 🤍
```

Both the cold-DM/redelivery and gated-delivery closing paths must apply the same policy. The non-follower path must not accidentally lose the existing follow ask.

Store question state on the person, not on a completed conversation state. A completed guide journey must remain complete.

### Eligibility for asking

Ask only when:

- A guide was successfully delivered.
- No reliable child age is already stored.
- The question has not already been asked inside the approved cooldown/lifetime rule.
- The sender is not classified as a business or promotional account.
- The message is inside the existing lawful delivery interaction.
- The person has not opted out.

Do not infer that every account requesting a guide is a parent. The historical inbox included jewelry and affiliate-promotion accounts. Use conservative business detection and fail by skipping the question, not by making a personal assumption.

### Slice A decisions

- Confirm exact-age versus age-band wording.
- Decide whether one answered profile is lifetime-stable or periodically refreshed.
- Define handling for multiple children and caregivers such as grandparents.
- Define question cooldown after no answer.
- Set the answer-rate threshold required to proceed to routing.

### Slice A acceptance criteria

- Guide delivery completes before the question appears.
- Both follower and non-follower closing paths include approved wording.
- The follow ask remains present where applicable.
- A known age prevents repeat asking.
- A prior unanswered ask respects the approved cooldown.
- Business/promotional senders and opt-outs are skipped.
- Exact sent text and eligibility evidence are logged.
- Failure to append the question never blocks guide delivery.

## PARENT-001 Slice B — Parse conservatively

Observed answer forms included:

| Form | Example | Normalized result |
|---|---|---:|
| Plain months | `My baby is also 18 months` | 18 months |
| Plain years | `my 2 year old grandson` | 24 months |
| Decimal years | `My daughter is about 1.5 years old` | 18 months |
| Mixed | `My daughter is 2year 1 month old` | 25 months |
| No spacing | `Mera v aaj hi 20months complete hua` | 20 months |
| Hinglish | `Mera 2 year boy kabi b pot pr nhi baithta` | 24 months |
| Infant decimal months | `My baby is 1.5 month old` | approximately 1 month under the selected rounding rule |

Numbers near age language are not always ages. Real counterexamples included:

- `for about 6 months he's stuck in this limited diet`
- `Ab soch rhi hu 2 months aur ruk jau`

A parser that stores 6 or 2 months for those messages would corrupt the profile and could recommend unsafe or irrelevant material.

### Parsing strategy

1. Check keyword and open-gate automation first. An active keyword wins over age extraction.
2. Apply deterministic parsing to unambiguous common forms.
3. Use a constrained model only when deterministic parsing misses and a model-based path is approved.
4. Require the model to return normalized age evidence, confidence, and `null` on ambiguity.
5. Store no age when confidence is below threshold.
6. Continue ordinary draft/fallback handling after a null parse.

Potential person fields include normalized age in months, asked timestamp, source, confidence, evidence timestamp, and a correction/supersession path. Avoid storing raw family details beyond what is needed and already retained in the DM record.

### Multiple-child and change model

The historical design assumed one age on `IgUser`, but a production design must explicitly choose:

- One primary/most recently discussed child.
- A small child-profile collection.
- No durable exact age, only an interaction-specific age band.

One scalar is simplest but can be wrong for twins, siblings, grandparents, or a changed topic. A collection is more accurate but expands privacy, correction, routing, and UI scope. The smallest experiment can store one normalized answer with provenance while postponing a generalized family model.

### Slice B acceptance criteria

- Every observed positive example has a deterministic expected result or an explicitly model-routed result.
- Both real duration/wait counterexamples return `null`.
- Keyword matching retains precedence.
- Confidence, source, and evidence time are stored with any normalized value.
- Ambiguous, implausible, multiple-child, and changed-age messages fail safely.
- The parent can correct a stored value through a documented owner or user flow.
- Tests include spacing, decimals, mixed units, multilingual forms, duration phrases, twins/siblings, and keyword collisions.

## PARENT-001 Slice C — Retrieve candidates and let the drafter select

The model must not invent parenting advice. The main API should retrieve a bounded set of already-reviewed resources; the drafter may select from them and produce only an approved response template.

Initial hard filter:

```sql
WHERE kind IN ('guide', 'recipes', 'activity')
  AND theme = :theme
  AND (age_min_months IS NULL OR :age >= age_min_months)
  AND (age_max_months IS NULL OR :age <= age_max_months)
```

`product_links` must be excluded from candidate routing. Historical data included bare affiliate-link resources; sending one as the answer to a struggling parent is an unacceptable failure mode.

Provide the isolated runtime with no database access. The API sends at most a bounded candidate set containing resource identity, approved type, theme, description, age range, and short reviewed page excerpts. The runtime chooses only among supplied candidates.

### No-match behavior

When no safe, age-appropriate resource exists:

- Do not stretch an age range.
- Do not invent advice.
- Do not substitute an affiliate link.
- Record the content gap.
- Optionally create an owner-reviewed draft acknowledging that there is no matching resource.

This is expected for younger infants and some themes. Treat it as editorial demand evidence, not a software error.

### Slice C decisions

- How is theme inferred: explicit answer, current guide, constrained model, or owner review?
- Is selection automatically sent inside a valid window, or always drafted for owner approval?
- What maximum candidate count and excerpt size are allowed?
- How are multiple equally valid resources ranked?
- What answer-rate, parse precision, and candidate coverage thresholds must pass before launch?

### Slice C acceptance criteria

- SQL never returns `product_links`.
- Age constraints are hard filters.
- The runtime receives only bounded reviewed candidates and no database credentials.
- The selected resource identifier must be one of the supplied candidates.
- No-match returns a safe explicit state.
- Tests cover boundary ages, null age ranges, wrong theme, empty candidate sets, affiliate exclusion, and invalid model selection.
- Nothing sends outside a valid messaging window or outside the approved owner-review boundary.

## PARENT-001 Slice D — Optional warm invitation

The historical design bundled an age-aware Circle invitation after an answer. This canonical backlog separates the invitation into `GROW-006` so answer-rate and routing experiments are not confounded.

If later approved, `GROW-006` can attach after the age answer and use approved context. Existing resource footers remain untouched until evidence supports a change.

## PARENT-001 Slice E — Backfill real DM history

The source audit found approximately 2,511 `message_received` events containing sender, text, provider message ID, and timestamp. These are recorded observations, not reconstructed guesses, and can safely seed `DmMessage` if the uniqueness contract makes the operation idempotent.

The backfill matters because historical substantive parent questions provide evaluation cases for parsing, routing, and shadow drafting.

Requirements:

- Implement as a reviewed one-off script.
- Support `--dry-run` and `--write`.
- Deduplicate by provider message ID.
- Report insert, existing, malformed, skipped, and conflict counts.
- Never invent missing bodies or timestamps.
- Sample results before write and verify counts after write.

### Cross-slice success metrics

| Outcome | Metric | Historical baseline |
|---|---|---|
| Question viability | Eligible parents answering | Unknown; measure first |
| Parse viability | Confident valid parses / answers | Unknown; measure first |
| Repeat value | People completing 2+ keyword/resource interactions | 63 of 1,266, about 5% |
| Reduced silence | Meaningful `message_unhandled` volume | Approximately 7/day, 673 total |
| Content coverage | Safe candidates by age/theme | Unknown; calculate before Slice C |
| Retention | Guide-follower yield and 21-day follow-through | Historically around 22% in related measurement |

### Stop and expansion rules

- If answer rate is below the approved threshold, stop after A/B and revisit the question or timing.
- If parse precision is insufficient, use age bands or owner review rather than broad model inference.
- If candidate coverage is low, prioritize content creation before automated routing.
- Any complaint or evidence that the question feels intrusive triggers copy/eligibility review.
- Do not expand profile scope merely because data can be extracted.

### Privacy and safety

- Collect only information tied to a defined recommendation purpose.
- Document retention, correction, deletion, and access.
- Avoid exposing exact child age in shareable outputs without explicit confirmation.
- Do not infer or diagnose developmental status from age and behavior.
- Keep parent-specific data in purpose-built DM/profile storage, not a general assistant memory.

### Dependencies

- `REL-001` improves auditability for routed messages.
- `REL-003` informs whether the final response can use owner-reviewed drafting.
- `PARENT-004` may improve reusable catalog structure later but is not required for initial guide/activity/recipe routing.
- `PARENT-003` can consume age bands only after privacy and correction rules are stable.

---

## PARENT-002 — Engagement Copilot evolution

**Source:** IA-FR-001

**State:** Candidate. The safe owner-reviewed foundation is shipped; the proposed expansion is unapproved, and a more autonomous stale-worktree experiment is not production-ready.

**Size:** Medium for better prioritization and shadow classification; Extra Large for supervised automation.

### Opportunity

Help the owner sustain useful parent conversations, learn recurring needs, and recognize safe next actions without impersonating the owner or automating sensitive parenting advice.

### Existing safe boundary

- Codex captures context and drafts replies.
- The owner can edit, regenerate, dismiss, approve, and send.
- Follow-up drafts can be scheduled but remain owner-reviewed.
- The advisor is read-only.
- The Codex runtime has no Instagram credentials or direct send primitive.

Preserve this boundary unless a separately approved experiment lawfully changes one narrow message class.

### Stale experiment concepts worth retaining—not code to merge

- Deterministic control and treatment assignment.
- A strict conversation and message cap.
- Independent safety review before a send and after new inbound activity.
- Handoff for unsupported media, hostility, prompt injection, health/development, payment, legal topics, uncertainty, and opt-outs.
- One optional repost request only after explicit positive feedback.
- Experiment metrics and operational monitoring.

A locally defined 72-hour window is not legal authorization and must not be reused without current Meta verification.

### Product directions

#### A — Owner-approved Copilot only — current baseline and recommendation

Improve prioritization, classification, context assembly, and draft quality while every outbound remains owner-approved.

#### B — Supervised staged automation

After shadow and owner-reviewed evidence, allow one narrow, low-risk, ordinary message class to auto-send inside a valid window, with deterministic control, caps, independent safety, escalation, and a kill switch.

#### C — Broad autonomous conversation agent

Let Codex select and send most replies. This carries the highest brand, safety, policy, medical-boundary, and recovery risk and is not a reasonable default extension.

### Recommended learning ladder

1. Complete `REL-003` shadow evaluation.
2. Measure owner approval, dismissal, edits, latency, and category-specific quality.
3. Add shadow `reply`, `complete`, or `handoff` recommendations without sending.
4. Improve queue prioritization and owner throughput.
5. Only if evidence supports it, design one allowlisted auto-response category.
6. Keep positive-feedback advocacy as a separate `GROW-005` experiment.

### Decisions required before any expansion

- Primary goal: faster replies, deeper insight, repeat resource use, advocacy, or owner time saved.
- Eligible and prohibited message classes.
- What always requires human review.
- Whether automated text identifies itself as automated.
- Maximum messages, conversation duration, and cooldown.
- Applicable messaging window for every path.
- Safety and escalation behavior for each high-risk class.
- Required sample, quality, and safety thresholds.

### Measurement

- Draft approval, edit, regeneration, and dismissal rates.
- Edit distance and substantive correction categories.
- Time from inbound to draft and to owner action.
- Meaningful reply rate and conversation completion.
- Questions and content gaps discovered.
- Unsafe/uncertain handoff rate.
- Opt-outs, complaints, blocks, negative replies, and ambiguous sends.
- Owner minutes per useful conversation.
- Treatment versus control outcomes with uncertainty.

### Non-negotiable constraints

- Never diagnose medical, developmental, or psychological conditions.
- Never claim personal owner review when it did not occur.
- Never make guide access conditional on conversation, sharing, or following.
- Fail closed on uncertainty, safety-review failure, policy ambiguity, and send ambiguity.
- Preserve exact prompts, model versions, decisions, text, approvals, provider results, and outcomes.
- Keep credentials and send primitives out of the Codex runtime.
- A new inbound message invalidates stale context and requires a fresh decision.

### Design-ready evidence

- The autonomy boundary is one unambiguous sentence.
- Eligible and ineligible examples are enumerated.
- Current Meta rules are verified from primary sources and observed behavior.
- Control, caps, stop rules, escalation, monitoring, and rollback are explicit.
- No stale-worktree implementation is adopted without tests against current `main`.

### Dependencies

`REL-001` for complete audit history, `REL-003` for baseline evidence, and `REL-004` for sustainable owner workflow.

---

## PARENT-003 — Personalized shareable parenting artifacts

**Source:** IA-FR-003

**State:** Candidate. No focused design or implementation exists.

**Size:** Small static experiment; Large for generalized or AI-generated artifacts.

### Opportunity

Turn reviewed parenting guidance into something useful enough to save or voluntarily share: a bedtime plan, routine checklist, activity card, milestone card, or `Add Yours` prompt with subtle Tiny SOHO attribution.

### Product directions

- Static reviewed template library.
- Light personalization using an approved age band, goal, or selected routine.
- AI-generated branded image after owner or user confirmation.
- Interactive mobile page that can be edited, saved, or exported.

### Recommended smallest experiment

Use one reviewed static template for one high-volume guide. Avoid names and exact ages. Let the parent download or save it without requiring a share. Measure generation/view, download/save intent, observable mentions, qualitative feedback, and repeat guide behavior.

Only add personalization if the static artifact is used. Only add AI imagery or an editor if personalization materially improves usefulness.

### Decisions required

- Which measured parent need and guide produce the first artifact?
- Is the useful unit a checklist, plan, card, or prompt?
- What data can appear safely on a shareable image?
- How visible should branding be?
- Does the artifact expire or remain accessible?
- Is sharing a native deep link, manual instruction, or simple export?
- Who approves templates and copy updates?

### Risks and safeguards

- Names, exact ages, routines, and developmental concerns can expose child information.
- Actual Instagram sharing may be unobservable.
- Generated visuals need accessible text, mobile rendering, deterministic fallback, and content review.
- Do not make sharing a condition for receiving or keeping the artifact.
- Do not infer medical/developmental milestones.

### Acceptance criteria for the experiment

- One approved template renders consistently on target mobile sizes.
- No personal child data appears by default.
- Download/save works without social sharing.
- Accessibility includes readable text, contrast, and alternative representation.
- Branding and disclosure are approved.
- Observable versus self-reported sharing is separated.
- A pre-approved usage threshold determines whether to expand.

### Dependencies

Can launch statically without `PARENT-001`. Age-aware personalization depends on stable profile purpose, correction, privacy, and retention rules from `PARENT-001`.

---

## PARENT-004 — Product and resource catalog

**Source:** IA-FR-009

**State:** Candidate. It was historically deferred because demand was not proven.

**Size:** Medium–Large.

### Opportunity

Store reviewed products, materials, books, and links once; reuse them across guides; provide regional alternatives; and prevent stale or inconsistent recommendations embedded in prose.

### Product directions

- Structured product block inside each guide.
- Normalized catalog with many-to-many resource relationships.
- Curated age/topic collections.
- Affiliate-aware catalog with merchant, region, disclosure, link health, and attribution.

### Recommendation

Do not build a generalized catalog first. Inventory repeated products across the highest-volume resources and identify a concrete editorial, safety, or revenue problem. If meaningful duplication exists, normalize only those items and render them through the existing reviewed resource-delivery path.

### Decisions required

- Primary need: editorial reuse, link safety, affiliate revenue, regional alternatives, or user browsing.
- Supported item types.
- Regional availability and substitution behavior.
- Link ownership, validation interval, and broken-link handling.
- Affiliate disclosure placement.
- Whether unavailable products are hidden, replaced, or shown with warning.
- Whether product links may ever participate in automated recommendation. The current answer for `PARENT-001` routing is no.

### Risks

- Historical delivery volume for `Book` and `Link` resources was low.
- Affiliate content introduces disclosure, region, maintenance, and trust obligations.
- Normalization creates admin and migration work before a user need exists.
- Automated product selection can turn helpful parenting support into inappropriate commerce.

### Acceptance criteria for a validation slice

- A current inventory quantifies repeated items and broken/region-specific links.
- One concrete workflow improvement is selected.
- Data ownership and disclosure rules are explicit.
- Existing guide delivery remains stable.
- Product items remain excluded from age-aware automated routing unless a separate design changes that safety rule.
- Expansion depends on measured reuse or maintenance value.

---

# Content and audience intelligence

## INSIGHT-001 — Age/gender demographics and navigation metrics

**Source:** FR-6

**State:** Candidate. Historical checks suggested existing insights permission was sufficient, but fields and responses must be reverified against the current Meta API version before design.

**Size:** Small–Medium, preferably two independent slices.

### Opportunity

Improve two different decisions:

1. Understand the age/gender composition of the reached/follower audience.
2. Replace an approximate hook-strength signal with the platform's observed navigation actions where available.

These should share permission and data-quality work but remain independently shippable.

## INSIGHT-001A — Age and gender breakdowns

The current demographics fetcher historically requested only `country`, even though its response parser already understood breakdown dimension keys and result arrays.

For a toddler-parenting account, age-band and gender distributions can inform content framing, caregiver representation, and topic priorities. They should remain aggregate audience insights, not individual inference.

### Storage options

#### A — Add fixed columns/models for each breakdown

Simple queries and explicit types, but every new dimension changes the schema.

#### B — Generic dimension/value snapshot — recommended if response contracts are stable

Store metric, dimension key(s), value key(s), count/value, period, captured time, API version, and completeness metadata. More flexible but requires strict validation to avoid an untyped dumping ground.

#### C — Store raw payload only

Fastest capture but weak for durable queries and UI contracts. Raw evidence can supplement, not replace, normalized storage.

### Data-quality caution

The historical country result was capped at 45 countries and undercounted the true follower total by about 5%. Age and gender may have their own omission, privacy, threshold, or cap behavior. Never infer a full total by summing breakdown rows unless the response is verified complete. Use the platform's true follower-count metric for account totals.

### Decisions required

- Which audience metric and period matter: reached audience, engaged audience, followers, or more than one?
- Which age/gender combinations are useful enough to store?
- How often should snapshots refresh?
- What completeness metadata is displayed?
- Where should this live: Growth Lab, a demographics view, or an existing follower-flow surface?

### Acceptance criteria

- Current permissions and API fields are verified without requesting unnecessary scope.
- Raw response fixtures cover multiple dimensions and missing/thresholded data.
- Normalized rows retain metric, dimension, period, capture time, and API version.
- Caps or incompleteness are visible in the UI.
- Aggregate demographics are never presented as individual profile inference.
- Totals use authoritative account counts rather than capped breakdown sums.

## INSIGHT-001B — Navigation breakdown on media insights

Historical inspection found no `navigation` metric in the Meta client. Where currently supported, navigation can separate forward taps/swipes, exits, and back actions, giving a more direct hook/retention signal than a locally approximated `skipRate`.

Also evaluate `views` and `total_interactions` only if they answer a named decision and are supported for the relevant media/account type.

### Required validation

- Confirm metric availability for current Reel/media types and API version.
- Capture real payloads for several media ages and performance levels.
- Determine whether results are lifetime, period-bound, or delayed.
- Re-measure per-Reel snapshot coverage. Historical coverage drifted from 441 to 392 Reels over five days, which made day-over-day comparisons untrustworthy.

### Decisions required

- Is navigation a descriptive content metric or part of candidate ranking?
- Which navigation actions become the primary hook signal?
- How should navigation reconcile with existing `skipRate`?
- What minimum reach/view count suppresses unstable percentages?

### Acceptance criteria

- Coverage is stable or the coverage defect is fixed first.
- Navigation fields are fetched, stored, and versioned from verified responses.
- The UI compares navigation and approximate skip rate without pretending they are identical.
- Percentages are suppressed below an approved denominator.
- Unsupported or thresholded media have explicit states.
- Tests cover missing fields, zero denominator, delayed data, deleted media, and mixed media types.

### Sequencing

Build 1A and 1B independently. If snapshot coverage remains unstable, 1A can proceed while 1B waits.

---

## INSIGHT-002 — Trial Reel tagging and experiments

**Source:** IA-FR-005

**State:** Candidate. Existing stored post data did not historically identify Trial Reels; current API feasibility remains unproven.

**Size:** Small for manual tagging; Medium–Large for automated experiment management.

### Opportunity

Compare Trial Reels with regular Reels, identify hooks that work with non-followers, and decide which concepts deserve a broader release or controlled variation.

### Product directions

1. Manual Trial/regular classification and hook label.
2. API-derived Trial classification if a stable current field is proven.
3. Pre-registered experiment runner with hypothesis, creative variable, window, and decision rule.
4. Recommendation layer suggesting the next variation.

### Recommended first slice

Add manual classification, one tested-variable label, and a small fixed metric set. Compare content over the same age window. Do not automate detection until a real API response proves it. Do not add recommendations until disciplined tests produce enough comparable history.

### Measurement choices

Candidate metrics include non-follower reach, watch time/retention, navigation, shares, saves, profile activity, guide conversion, and directional follow outcomes. Select a primary metric per experiment. Avoid declaring a winner from whichever metric happens to look best afterward.

### Decisions required

- Can current Meta data expose Trial status?
- Which outcome is primary for Tiny SOHO?
- What content-age window makes comparisons fair?
- What is the minimum exposure/sample?
- What single creative variable is being tested?
- How are simultaneous changes and posting-time differences handled?
- Is the surface descriptive only or allowed to recommend the next test?

### Acceptance criteria for manual v1

- Owner can mark Trial/regular and name one hypothesis/variable.
- The experiment start, comparison window, primary metric, and decision rule are frozen before reading results.
- Content is compared over equivalent age windows.
- Missing historical follower attribution is disclosed.
- Results show denominators and uncertainty, not only ranks.
- Editing a label does not rewrite historical experiment evidence without an audit trail.

### Risks

- Trial support and fields can change by API version/account.
- Posting time, audience size, creative differences, and account growth confound naive comparisons.
- Historical exact per-Reel follows cannot be reconstructed.
- A recommendation layer can overfit a small, changing content catalog.

### Dependencies

`REL-002` supplies recent reach contribution; `INSIGHT-001B` may add better hook behavior. Neither is a hard prerequisite for manual tagging.

---

## INSIGHT-003 — Audience intelligence and profile enrichment

**Source:** IA-FR-006

**State:** Candidate. External providers were discussed, but coverage, accuracy, privacy, cost, terms, and platform risk were never established.

**Size:** Spike first. Ongoing individual enrichment would be a separate architectural project.

### Opportunity

Understand which needs, topics, languages, broad audience categories, and interaction patterns correlate with useful conversations, guide completion, retention, or owned conversion.

### Critical framing

Start with the decision, not the data source. If no content, product, or operating decision will change, enrichment is unjustified.

Prefer first-party aggregate evidence already collected through comments, DMs, guide flows, voluntary answers, and account insights. Public profile visibility does not remove privacy, fairness, deletion, provenance, or platform obligations.

### Product directions

#### A — First-party aggregate intelligence — recommended

Analyze existing interactions and voluntary answers. Minimize individual inference and keep results linked to observable events.

#### B — Small external proof

Test 50–100 public profiles for one decision question. Record field coverage, false classifications, cost, latency, provenance, deletion, provider terms, and decision impact.

#### C — Ongoing enrichment

Enrich participants after interaction. This creates persistent privacy, provider, correction, and access-control responsibilities and is not justified without a successful proof.

#### D — Aggregate derived segments only

Derive reviewed non-sensitive categories, then discard raw external details where legally and operationally appropriate.

### Prohibited shortcuts

- Do not treat a name or username as reliable geography, ethnicity, parenting status, gender, or intent.
- Do not label probabilistic origin as exact per-user geography.
- Do not infer sensitive traits merely because a provider returns them.
- Do not put parent-specific enrichment in general assistant memory.

### Decisions required

- What exact decision will the data change?
- Is individual-level output necessary, or is aggregate enough?
- Which fields are permitted and useful?
- What accuracy and coverage threshold is required?
- What are consent, notice, retention, correction, deletion, and access rules?
- Which sensitive inferences are prohibited?
- Does value justify external-provider dependence?

### Acceptance criteria for a spike

- One decision question and one bounded sample are pre-registered.
- Ground-truth review estimates false-positive and false-negative behavior.
- Coverage, cost, latency, provenance, terms, and deletion are documented.
- Sensitive and unreliable fields are excluded.
- Results are evaluated by whether they change a real decision.
- No production enrichment pipeline is created by the spike.

### Stop rule

Stop if the sample does not change a decision, cannot meet accuracy/privacy thresholds, or relies on prohibited inference. Do not convert an inconclusive spike into a generalized data product.

---

## INSIGHT-004 — Competitor intelligence and guide opportunities

**Source:** IA-FR-007

**State:** Candidate. No collection integration or approved analysis workflow exists.

**Size:** Manual spike first.

### Opportunity

Study competitor or adjacent creators' public content and recurring parent questions to identify content patterns and unmet needs that might become Tiny SOHO guides or experiments.

### Product directions

- Manual research inbox for owner-supplied post URLs or exports.
- Bounded monitored account set through an approved provider.
- Guide Opportunities view clustering repeated problems with provenance.
- Creative-pattern analysis of hooks, formats, and themes without copying expression.

### Recommended smallest experiment

The owner supplies a small set of public posts and comments from a few named accounts. Produce a reviewed list of repeated parent problems with:

- Source links.
- Evidence counts.
- Representative short paraphrases.
- Confidence and disagreement.
- Existing Tiny SOHO coverage.
- One proposed content decision.

Do not automate collection until the manual analysis changes a real content decision.

### Decisions required

- Which accounts and adjacent categories are in scope?
- What data may be collected, quoted, stored, and retained?
- Is manual URL submission sufficient?
- What evidence threshold promotes a cluster to an opportunity?
- Who reviews opportunities before content creation?
- Which provider and terms apply if monitoring expands?

### Risks

- Provider/API, copyright, and platform terms require review.
- Popular comments are not representative market research.
- Models can fabricate quotations, counts, and consensus.
- Creative analysis must not copy protected expression or another creator's distinctive work.

### Acceptance criteria for the spike

- Every finding links to source evidence.
- Counts are computed from the supplied dataset, not model memory.
- Quotes are minimized and provenance-preserved.
- Unsupported inference is labeled or removed.
- At least one finding results in an owner-approved content decision; otherwise automation stops.

---

## INSIGHT-005 — Creator and partnership discovery

**Source:** IA-FR-008

**State:** Candidate. No proven data source or scoring model.

**Size:** Manual spike first.

### Opportunity

Find complementary parenting creators whose topics, audience, geography, engagement quality, and brand values may support a Tiny SOHO collaboration.

### Product directions

- Evidence-backed discovery shortlist.
- Campaign workspace for review, contact status, idea, and outcome.
- Inbound-first matching among creators already engaging with Tiny SOHO.
- Aggregate audience-overlap estimates where reliable.

### Recommended smallest experiment

Create a manually reviewed shortlist of 20 candidates. For each, record source, reason for fit, risks, proposed collaboration, observable audience evidence, and owner verdict. The owner handles outreach outside the system.

Only build collection, ranking, or outreach management if the list produces viable conversations.

### Decisions required

- What defines fit: topic, audience, geography, values, scale, engagement quality, or a weighted combination?
- Is discovery enough, or is outreach tracking needed?
- What lawful and stable data source supports each field?
- Will Codex draft outreach, and does sending always remain owner-controlled?
- How are sponsorship disclosure, conflicts, and outcomes tracked?

### Acceptance criteria for the spike

- Every candidate has evidence for each asserted fit dimension.
- Scores are explainable and owner-reviewable.
- Missing data does not become an invented score.
- Outreach is not sent automatically.
- The owner records whether each candidate is useful enough to contact.
- Expansion requires a pre-approved number of viable opportunities or conversations.

---

## INSIGHT-006 — Historical lifetime content leaders

**Source:** IA-FR-010

**State:** Candidate. Current tools cover feed follow attribution and directional recent reach, not a clearly labeled lifetime-leaders view.

**Size:** Small–Medium.

### Opportunity

Show which historical media have the strongest currently available cumulative metrics without pretending exact past daily attribution can be reconstructed.

### Product directions

#### A — Cumulative lifetime table — recommended first slice

Display only verifiable lifetime values currently supplied by Meta, labeled with capture time and content age.

#### B — Forward snapshots

Begin daily or approved-cadence snapshots so future increments can be calculated honestly.

#### C — Mixed lifetime and forward view

Show lifetime totals and post-snapshot-start deltas in clearly separated columns.

#### D — Modeled historical estimates

Estimate old daily values with uncertainty. This has the highest confusion risk and is not recommended while cumulative truth answers the core question.

### Decisions required

- Which cumulative metrics are available and comparable for each media type?
- Should rankings normalize for content age or show both total and age?
- How are deleted, unavailable, or changed posts represented?
- Where should the view live?
- What language prevents cumulative values from being read as daily follow attribution?
- What snapshot cadence and retention are justified?

### Acceptance criteria

- Every displayed value maps to a verified current API/storage field.
- Lifetime totals are labeled as cumulative and captured at a timestamp.
- Content age and media type are visible.
- Forward deltas begin only after a known snapshot baseline.
- No invented historical daily values are backfilled.
- Deleted/unavailable media retain auditable historical identity where permitted.
- Tests cover metric absence, mixed media types, ties, content age, deleted media, and snapshot gaps.

### Relationship to REL-002

`INSIGHT-006` is cumulative. `REL-002` is a recent rolling-window contribution analysis. They should not share ambiguous titles such as `Top content` without a visible time basis.

---

# Infrastructure and continuity

## INFRA-001 — Shared, reviewed business memory

**Source:** IA-FR-011

**State:** Candidate. Native memory sharing between ChatGPT and Codex based only on shared account authentication is not available and must not be assumed.

**Size:** Small for a repository brief; Large for a generalized memory service.

### Opportunity

Give future Codex tasks and the in-product advisor a current, provenance-backed understanding of brand rules, approved policies, active experiments, measurements, decisions, supersessions, and open questions.

### Product directions

#### A — Repository-backed business brief — recommended

One owner-reviewed Markdown or structured file with current policies, priorities, experiments, and links to evidence. Changes go through normal review and Git history.

#### B — Structured decision log

Database records with statement, category, source, owner approval, effective date, expiry, and supersession.

#### C — Retrieval service

Search approved documents and measurements at answer time. Useful only when the source corpus and permissions justify the operational complexity.

#### D — Native assistant memory

Do not plan around it unless an explicit supported product capability is verified. Same-account authentication alone does not create shared application memory.

### Recommended smallest experiment

Create one owner-reviewed repository brief covering:

- Brand voice and prohibited claims.
- Audience and product context.
- Current messaging and safety policies.
- Active experiments and control groups.
- Current priorities.
- Approved metrics and definitions.
- Known platform constraints.
- Decisions pending owner input.
- Superseded decisions with links.

Allow the advisor to read it. Updates remain explicit, reviewed repository changes. Evaluate drift, retrieval usefulness, and maintenance cost before designing a service.

### Decisions required

- What information deserves durable memory?
- Who can propose and approve updates?
- How are conflicts, expiry, and supersession represented?
- What provenance is mandatory?
- Which assistants may read each category?
- Is parent-specific data categorically excluded? The recommended answer is yes.

### Data boundary

Parent conversations, ages, safety issues, and personal details remain in purpose-built systems with their own access and deletion rules. General business memory must not become a shadow customer database or a hidden write/action channel around the read-only advisor.

### Acceptance criteria for the brief

- Every durable claim has a source or explicit owner-decision record.
- Effective date and supersession are clear.
- Active experiments identify control/treatment and status.
- No parent-specific personal data is included.
- Advisor responses can cite the brief section used.
- Updates require owner review and leave Git history.
- A review cadence and stale-content indicator exist.

### Expansion rule

Build structured storage or retrieval only when the brief's size or usage creates a measured failure that cannot be solved with clear organization and direct links.

---

# Cross-feature dependencies and conflicts

| Item | Depends on or benefits from | Must not be confused or combined with |
|---|---|---|
| `REL-001` | Existing `DmMessage`, event log, recovery evidence | Full queue redesign; fix truth first |
| `REL-002` | Stable Reel snapshots | `INSIGHT-006` lifetime leaders |
| `REL-003` | Deployment access and owner review | Autonomous Copilot expansion |
| `REL-004` | `REL-001`; real examples from `REL-003` | Four separate object browsers |
| `REL-006` | Current sequence editor, router, and message-limit policy | Wholesale merge of the divergent guide-delivery branch |
| `GROW-001` | Cohort Funnels; stable public-reply policy | Exact per-person follow attribution |
| `GROW-002` | Recovery primitives, shared pacing and audience policy | Historical cohort figures as causal proof |
| `GROW-003` | Merged audience-segment vocabulary | Exact geography or ethnicity inference |
| `GROW-004` | Cached follower state | Live follow enforcement |
| `GROW-005` | Positive-feedback definition; valid window | `GROW-007` rewarded ambassador program |
| `GROW-006` | Verified destination/link | Per-user channel-join attribution |
| `GROW-008` | `REL-001`, public-safe provenance, owner review, shared public dispatch | Publishing private DM facts or reusing a private-reply prompt |
| `PARENT-001` | Structured resource library; optionally AI drafts | `GROW-006` in the first answer-rate experiment |
| `PARENT-002` | `REL-001`, `REL-003`, `REL-004` | Broad autonomy as a default |
| `PARENT-003` | Approved templates; later age-band privacy rules | Mandatory sharing or exact-age exposure |
| `PARENT-004` | Proven repeated-product demand | Automated affiliate recommendation in `PARENT-001` |
| `INSIGHT-001B` | Stable per-Reel coverage | Approximate skip rate as identical truth |
| `INSIGHT-002` | Manual experimental discipline | Retrospective winner selection |
| `INSIGHT-003` | Named decision question | Name/username-based sensitive inference |
| `INSIGHT-004` | Source-provenance workflow | Automated collection before manual value proof |
| `INSIGHT-005` | Owner-defined fit and evidence | Automated outreach |
| `INSIGHT-006` | Verified lifetime fields; future snapshots | Invented historical daily deltas |
| `INFRA-001` | Owner review and provenance | Parent-specific memory or an action channel |

## Experiment-interference rules

- Do not simultaneously change public acknowledgement copy and recovery timing for the same cohort without a factorial design that the available volume can support.
- Keep audience-policy treatment consistent across experiment arms.
- Freeze copy, timing, assignment, eligibility, and outcome windows before launch.
- A material configuration change creates a new experiment version.
- Shared contact capacity, cooldowns, and circuit breakers apply across campaigns.
- Control participants must not receive the treatment through a different path.
- Analyze by original assignment as well as actual send where appropriate; do not discard suppressed or failed treatment rows.
- Do not run `GROW-008` contextual public replies against the same primary outcome as `GROW-001` or `GROW-002` unless the design isolates the interventions and available volume supports it.

---

# Prioritization by desired business outcome

## If the goal is trustworthy operations

1. `REL-001` complete person timeline.
2. `REL-002` accurate recent-reach contribution.
3. `REL-003` AI shadow audit.
4. `REL-004` unified actionable queue.
5. `REL-005` journey reconciliation decision.
6. `REL-006` focused integration of explicit sequence saves.

## If the goal is more useful parent conversations

1. `REL-001` for complete auditability.
2. `PARENT-001` Slices A and B only.
3. `REL-003` owner-reviewed draft baseline.
4. `PARENT-002` better classification and owner workflow.
5. `GROW-008` owner-reviewed public-context experiment after the privacy boundary is proven.
6. `PARENT-003` one static artifact based on a measured need.

## If the goal is follower and organic-reach learning

1. `GROW-001` public-reply experiment.
2. `GROW-002` timely recovery experiment, run in a non-confounded period.
3. `GROW-008` owner-reviewed contextual public engagement in a non-confounded period.
4. `GROW-005` one voluntary repost ask.
5. `INSIGHT-002` manual Trial Reel experiments.
6. `GROW-007` manual ambassador pilot only after an observable outcome is selected.

## If the goal is better content strategy

1. `REL-002` recent contribution truth.
2. `INSIGHT-001` demographics and navigation.
3. `INSIGHT-002` manual Trial Reel tagging.
4. `INSIGHT-004` manual competitor evidence sample.
5. `INSIGHT-003` first-party aggregate audience intelligence.
6. `INSIGHT-006` lifetime leaders and forward snapshots.

## If the goal is infrastructure and continuity

1. `INFRA-001` repository-backed brief.
2. `PARENT-004` demand inventory before catalog design.
3. `INSIGHT-006` forward cumulative snapshots.

---

# Owner decision queue

These are the highest-leverage unresolved questions. Resolve them only when their feature is selected; they do not need to be answered all at once.

1. **Admin cadence (`REL-004`):** more than once daily or approximately once each morning?
2. **Age-loop viability (`PARENT-001`):** exact age, age band, need-first, or passive extraction?
3. **Public-reply experiment (`GROW-001`):** approve final control/treatment copy and minimum useful lift.
4. **Recovery experiment (`GROW-002`):** select delay, eligible audience segments, and exact copy.
5. **Audience policy (`GROW-003`):** skip only public acknowledgement, suppress all automation, or retain current universal behavior?
6. **Public-context V2 (`GROW-008`):** owner-reviewed only for the first slice, and which fact provenances are safe to reuse publicly?
7. **AI operation (`REL-003`):** after shadow review, remain draft-only or authorize owner-approved sending?
8. **Channel invite (`GROW-006`):** which destination, link, copy, and placement?
9. **Advocacy (`GROW-005`):** which single action is desired and observable?
10. **Trial Reels (`INSIGHT-002`):** which primary outcome defines a useful creative test?
11. **Memory (`INFRA-001`):** which facts deserve owner-approved durable status?

---

# Closed, completed, superseded, and infeasible ideas

## Do not re-open as ordinary feature requests

| Idea | Disposition |
|---|---|
| Send another automated DM to commenters who ignored the one private gate reply | Mechanically unavailable under the documented private-reply constraint |
| Exact historical daily per-Reel follow attribution | Insufficient historical platform data; use directional or cumulative language |
| Exact per-user geography from current Instagram data | No reliable path identified; do not substitute names/usernames |
| Exact per-user Broadcast Channel/Circle join attribution | No usable API path established; reverify before using it as an outcome |
| Native memory automatically shared between ChatGPT and Codex due to same-account login | Unsupported assumption; use `INFRA-001` |
| Autonomous sends outside Meta's applicable messaging window | Not authorized by Codex, owner login, or local timers |
| CT-3 Conversations breakdown | Duplicate of FR-2; consolidated into `REL-004` |
| IA-FR-012 age-aware profile | Duplicate/earlier framing; consolidated into `PARENT-001` |

## Already completed or substantially superseded

- Feed follow attribution and its detail drawer.
- Country/date follower-flow filters and country drilldown.
- Growth Lab capture-rate and next-test recommendations.
- Codex runtime and ChatGPT connection.
- Owner-approved DM drafting controls.
- Read-only business advisor.
- Owner-reviewed post-guide follow-up foundation.
- Historical recovery and earlier Features 1–4 recovery work.
- Expanded recovery audience segmentation.
- Cohort Funnels page and service layer.
- All-token live comment matching.
- Experiment capture-rate and recommendation helpers.
- Gate retry-tail tuning.
- Directional follow-through measurement.
- Shared public-recovery contact ledger.
- Follower-flow provisional-day rate-basis correction.

The old “past audience reactivation” request became shipped historical recovery. Its historical spec status should not be used to create new work.

## Not software features

- The division of labor between bot and human account activity is an operating agreement.
- Enabling or disabling deployed AI flags is an operational authorization, represented by `REL-003`, not a request to rebuild the system.
- Applying journey reconciliation is a production data decision, represented by `REL-005`.

---

# Standard focused-design template

When an item is selected, its approved design should record:

1. Canonical backlog ID and title.
2. Problem, target user, and business outcome.
3. Current evidence with measurement date and query/source.
4. Selected option and rejected alternatives with reasons.
5. Included and excluded scope.
6. User and system flow.
7. Data model and provenance.
8. External API and policy verification.
9. Privacy, consent, retention, correction, and deletion.
10. Owner-approval and automation boundary.
11. Failure, retry, ambiguous-outcome, deduplication, and rollback behavior.
12. Experiment assignment, control, sample, success, harm, futility, and stop rules where applicable.
13. Shared pacing, cooldown, capacity, and circuit-breaker effects.
14. Dependencies and rollout order.
15. Acceptance criteria.
16. Test and production-verification plan.
17. Monitoring and post-launch decision date.

Do not mark an item approved because an agent recommends it. Record explicit owner approval in the focused design.

---

# Repository and delivery conventions

| Concern | Convention |
|---|---|
| Backend tests | `npm test` |
| Backend typecheck/build | `npm run build` |
| Web tests | `cd web && npm test` |
| Web production build | `cd web && npm run build` with required environment |
| Web lint | `cd web && npm run lint` |
| Migrations | Local development through Prisma; deployment through the documented Railway startup path |
| Backend deployment | Railway `api` service |
| Frontend deployment | Follow `DEPLOY.md`; historically required explicit `vercel --prod` because Git push alone did not deploy |
| Production writes | Reviewed script with `--dry-run` before `--write` |
| Boolean environment flags | `src/config/booleanFlag.ts` |
| External policy claims | Current primary Meta documentation plus observed behavior in `docs/meta-verification.md` |

Revalidate every convention at implementation time.

---

# Provenance

This canonical backlog consolidates:

- The 2026-08-13 unstarted Instagram automation backlog audit.
- The 2026-08-14 unstarted feature-request audit.
- The 2026-08-14 Claude-transcript unfinished-design audit.
- The 2026-08-07 settings-fallback, journey-reconciliation, and historical-recovery design, whose materially shipped work is retained in the delivered/closed sections and whose remaining write decision maps to `REL-005`.
- The 2026-08-20 audit of every visible local/remote Git ref, linked physical worktree, and branch-only Markdown design or plan.
- The owner's 2026-08-20 request for history-aware public follower engagement.

All 24 source IDs from the three historical registers map to a canonical item above. The cross-ref/worktree audit added `REL-006`; the owner conversation added `GROW-008`. No additional untracked feature register was found. Recent documents that described implementations, runbooks, QA, or operating decisions were not duplicated as new feature ideas unless they introduced a distinct product behavior.

The removed source files remain recoverable in Git commit `de89d3f`; the verified consolidation is recorded in `25fd441`. The source audits were high-precision transcript reviews, not a guarantee that every spoken idea before 2026-08-16 was captured. This file is the only feature-request document in the working tree and controls active intake, lifecycle, prioritization, and de-duplication from 2026-08-20 onward.
