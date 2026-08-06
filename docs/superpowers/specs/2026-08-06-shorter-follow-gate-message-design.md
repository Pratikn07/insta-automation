# Shorter Follow-Gate Message Design

## Goal

Shorten the follow-required reply sent when a confirmed non-follower responds to an open Instagram automation gate.

## Message Change

Replace:

> You're one step away! 💛 Follow @tinysoho, then reply DONE here and I'll send it right over. (Just followed? Give it a few seconds and reply DONE again.)

With:

> You're one step away! 💛 Follow @tinysoho, then reply DONE here and I'll send it right over.

## Scope

Change only the `FOLLOW_GATE` message in `src/handlers/messageHandler.ts`. Keep the initial keyword-specific gate message, follower detection, conversation state transitions, guide delivery, analytics events, and all other automation behavior unchanged.

## Verification

Add an exact-text assertion to the existing non-follower follow-gate handler test. Confirm the assertion fails before the production message changes, then passes afterward. Run the focused handler test, the full test suite, and the TypeScript build.
