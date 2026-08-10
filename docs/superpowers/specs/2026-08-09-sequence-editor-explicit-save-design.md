# Sequence Editor Explicit Save Design

**Date:** 2026-08-09
**Status:** Approved

## Goal

Make it obvious and deliberate when authored sequence text is persisted. Authors should never have to infer whether a pasted or edited guide message was saved.

## Considered approaches

1. **Recommended: explicit save for authored text, immediate persistence for structural actions.** The sequence name, internal note, and message/caption bodies remain local drafts until the author saves. Adding, deleting, reordering, and uploading continue to persist immediately because each is already a discrete user action.
2. **Keep autosave and add a decorative Save button.** This is a small change, but the button would often become disabled as soon as focus leaves a field, which would remain confusing.
3. **Replace every editor action with one transactional Save All endpoint.** This offers the strongest atomicity but expands the change into a new backend aggregate API and changes established add/delete/upload behavior without a demonstrated need.

Approach 1 provides clear author control without broadening the backend surface.

## User experience

- Place a primary **Save changes** button in the sequence editor header beside the save status.
- The button is disabled when there are no authored-text changes, while a save is in flight, when the sequence name is blank, or when any message/caption exceeds Instagram's 1,000 UTF-16-unit limit.
- The status is always meaningful: **All changes saved**, **Unsaved changes**, **Saving…**, **Couldn't save — retry**, or **Needs attention — message too long**.
- `Cmd+S` on macOS and `Ctrl+S` elsewhere invoke the same save operation and prevent the browser's page-save dialog.
- Leaving the editor through app navigation, browser back/forward, reload, or tab close while a draft is dirty or saving produces an unsaved-changes warning. The author can remain in the editor or deliberately discard the local draft.
- Successful saves leave the editor open and update the saved baseline. A failed request leaves the draft and Save button available for retry.

## Data flow

The editor owns both the current drafts and saved baselines for the resource fields and each message body. Dirty state is derived by comparing those values; it is not inferred from focus or mutation history.

When saving, the editor snapshots every dirty authored-text value and sends the existing resource/message PATCH requests. Each successful response advances only the corresponding saved baseline to the submitted snapshot. If the author types again while requests are in flight, the newer draft remains dirty. Query invalidation continues after success, but a refetch cannot overwrite a current draft.

The existing immediate mutations for add, delete, reorder, and media upload retain the shared sequence-save mutation key so the same status reports their progress and failures.

## Validation and errors

- The existing shared Instagram guide-message policy remains authoritative for counting and the 1,000-unit boundary.
- An over-limit message stays visible locally, is not submitted, disables Save, and shows the existing guidance.
- Save errors use safe existing API messages/toasts; raw errors are not rendered.
- A multi-request text save can partially succeed because the current APIs update individual records. Successful fields advance their baselines, failed fields remain dirty, and the status reports the failure so retry sends only the remaining dirty fields.

## Testing

Component tests will prove:

- editing authored text produces **Unsaved changes** without issuing a PATCH on blur;
- Save sends only dirty resource/message fields and returns to **All changes saved**;
- the button is disabled when clean, during save, for a blank name, and for an over-limit body;
- `Cmd+S`/`Ctrl+S` invokes the same save path;
- a failed save preserves the draft and allows retry;
- edits made during an in-flight save remain dirty after the earlier snapshot succeeds;
- in-app and browser-level navigation are guarded only while dirty or saving;
- add/delete/reorder/upload retain their existing immediate behavior.

The focused Sequence editor suite, full web test suite, lint, and production build must pass before completion.
