# Sequence Editor Explicit Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deliberate, visible Save changes workflow for sequence-authored text while preserving immediate structural edits.

**Architecture:** `SequenceEditorForm` will own current drafts and saved baselines, derive dirty state, and persist dirty resource/message text through the existing PATCH APIs. A focused navigation hook will combine React Router blocking with browser unload protection, while `SaveStatus` will render the explicit dirty/saving/saved/error states. The app will use React Router's data-router provider so supported navigation blocking covers sidebar links and browser back/forward navigation.

**Tech Stack:** React 19, TypeScript 6, React Router 7 data router, TanStack Query 5, Vitest 4, Testing Library, Tailwind UI components

## Global Constraints

- No backend, schema, or API contract changes.
- The sequence name, internal note, and message/caption bodies save only through Save changes or `Cmd+S`/`Ctrl+S`.
- Add, delete, reorder, and media upload actions continue to persist immediately.
- The existing shared 1,000 UTF-16-unit Instagram guide-message limit remains authoritative.
- A save error must preserve the local draft and expose only safe existing API copy.
- A successful field advances only to the exact submitted snapshot, so typing during an in-flight save remains dirty.

## File structure

- Create `web/src/hooks/useUnsavedChangesGuard.ts`: reusable SPA-navigation and browser-unload guard.
- Create `web/src/hooks/useUnsavedChangesGuard.test.tsx`: real data-router contracts for block, stay, leave, and unload behavior.
- Modify `web/src/App.tsx`: replace declarative `BrowserRouter` with `createBrowserRouter`/`RouterProvider`, preserving the current route tree and auth gate.
- Modify `web/src/components/SaveStatus.tsx`: render persistent clean state plus dirty, saving, attention, and error states.
- Modify `web/src/pages/SequenceEditor.tsx`: own saved baselines, explicit save orchestration, shortcut, validation, and leave-confirmation dialog.
- Modify `web/src/pages/SequenceEditor.test.tsx`: exercise the real editor behavior through a data-memory router.

---

### Task 1: Navigation blocking foundation

**Files:**
- Create: `web/src/hooks/useUnsavedChangesGuard.ts`
- Create: `web/src/hooks/useUnsavedChangesGuard.test.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Produces: `useUnsavedChangesGuard(shouldBlock: boolean): Blocker`
- Consumes: React Router `useBlocker` and `useBeforeUnload`

- [ ] **Step 1: Write failing hook tests**

Create a `createMemoryRouter` harness with an editor route and an away route. The harness renders a link and exposes `blocker.reset()` and `blocker.proceed()` as buttons when blocked.

```tsx
function GuardHarness({ shouldBlock }: { shouldBlock: boolean }) {
  const blocker = useUnsavedChangesGuard(shouldBlock);
  return (
    <>
      <Link to="/away">Away</Link>
      {blocker.state === "blocked" && (
        <>
          <button onClick={() => blocker.reset()}>Keep editing</button>
          <button onClick={() => blocker.proceed()}>Leave</button>
        </>
      )}
    </>
  );
}
```

Add independent tests proving:

```tsx
it("allows navigation when protection is off", async () => {
  const user = userEvent.setup();
  renderGuard(false);
  await user.click(screen.getByRole("link", { name: "Away" }));
  expect(await screen.findByText("Away page")).toBeInTheDocument();
});

it("blocks navigation until the author chooses whether to leave", async () => {
  const user = userEvent.setup();
  renderGuard(true);
  await user.click(screen.getByRole("link", { name: "Away" }));
  expect(screen.getByRole("button", { name: "Keep editing" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.queryByText("Away page")).not.toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "Away" }));
  await user.click(screen.getByRole("button", { name: "Leave" }));
  expect(await screen.findByText("Away page")).toBeInTheDocument();
});

it("prevents browser unload only while protection is on", async () => {
  const user = userEvent.setup();
  renderUnloadHarness();
  const cleanEvent = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(cleanEvent);
  expect(cleanEvent.defaultPrevented).toBe(false);
  await user.click(screen.getByRole("button", { name: "Make dirty" }));
  const dirtyEvent = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirtyEvent);
  expect(dirtyEvent.defaultPrevented).toBe(true);
});
```

Use these real render helpers rather than mocking React Router:

```tsx
function renderGuard(shouldBlock: boolean) {
  const router = createMemoryRouter(
    [
      { path: "/editor", element: <GuardHarness shouldBlock={shouldBlock} /> },
      { path: "/away", element: <p>Away page</p> },
    ],
    { initialEntries: ["/editor"] },
  );
  render(<RouterProvider router={router} />);
}

function UnloadHarness() {
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesGuard(dirty);
  return <button onClick={() => setDirty(true)}>Make dirty</button>;
}

function renderUnloadHarness() {
  const router = createMemoryRouter(
    [{ path: "/", element: <UnloadHarness /> }],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
}
```

- [ ] **Step 2: Run the hook suite and verify RED**

Run:

```bash
npm --prefix web test -- src/hooks/useUnsavedChangesGuard.test.tsx
```

Expected: FAIL because `useUnsavedChangesGuard` does not exist.

- [ ] **Step 3: Implement the minimal hook**

```ts
import { useCallback } from "react";
import { useBeforeUnload, useBlocker } from "react-router-dom";

export function useUnsavedChangesGuard(shouldBlock: boolean) {
  const blocker = useBlocker(shouldBlock);
  useBeforeUnload(
    useCallback(
      (event) => {
        if (!shouldBlock) return;
        event.preventDefault();
        event.returnValue = "";
      },
      [shouldBlock],
    ),
  );
  return blocker;
}
```

- [ ] **Step 4: Convert the app to a data router**

Keep the current auth and route behavior but move `BrowserRouter` ownership into a single provider:

```tsx
function AuthenticatedRoutes() {
  const { session, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  return session ? (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="content" element={<Content />} />
        <Route path="reels" element={<Navigate to="/content" replace />} />
        <Route path="keywords" element={<Keywords />} />
        <Route path="sequences" element={<Sequences />} />
        <Route path="sequences/:id" element={<SequenceEditor />} />
        <Route path="conversations" element={<Conversations />} />
        <Route path="assistant" element={<Assistant />} />
        <Route path="users" element={<Users />} />
        <Route path="insights" element={<Insights />} />
        <Route path="activity" element={<Activity />} />
        <Route path="historical-recovery" element={<HistoricalRecovery />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  ) : (
    <Routes>
      <Route path="*" element={<Login />} />
    </Routes>
  );
}

const router = createBrowserRouter([{ path: "*", element: <AuthenticatedRoutes /> }]);

export default function App() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm --prefix web test -- src/hooks/useUnsavedChangesGuard.test.tsx
npm --prefix web run build
git diff --check
```

Expected: hook tests pass, TypeScript/Vite build passes, and diff check is clean.

Commit:

```bash
git add web/src/App.tsx web/src/hooks/useUnsavedChangesGuard.ts web/src/hooks/useUnsavedChangesGuard.test.tsx
git commit -m "feat: guard unsaved sequence navigation"
```

### Task 2: Explicit authored-text save workflow

**Files:**
- Modify: `web/src/components/SaveStatus.tsx`
- Modify: `web/src/pages/SequenceEditor.tsx`
- Modify: `web/src/pages/SequenceEditor.test.tsx`

**Interfaces:**
- Consumes: `useUnsavedChangesGuard(shouldBlock: boolean): Blocker` from Task 1
- Produces: `SaveStatus({ sequenceId, dirty, needsAttention, saveFailed })`
- Produces local save target types:

```ts
type TextSaveTarget =
  | { kind: "resource"; name: string; description: string }
  | { kind: "message"; id: string; body: string | null };

type TextSaveResult =
  | { target: TextSaveTarget; ok: true }
  | { target: TextSaveTarget; ok: false; error: unknown };
```

- [ ] **Step 1: Update the test router and write the dirty-state RED tests**

Replace `MemoryRouter` with `createMemoryRouter` and `RouterProvider` so the real navigation blocker is available. Add an away route that renders `Sequences page`.

Add tests proving initial clean state and editing behavior:

```tsx
expect(await screen.findByText("All changes saved")).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

setBody("Draft body");
fireEvent.blur(bodyTextarea());
expect(messagePatchCalls()).toHaveLength(0);
expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
```

- [ ] **Step 2: Write the save, retry, and snapshot RED tests**

Add independent tests proving:

```tsx
it("saves only dirty resource and message text when requested", async () => {
  const user = userEvent.setup();
  renderEditor();
  const name = await screen.findByPlaceholderText("Sequence name");
  await user.clear(name);
  await user.type(name, "Updated sequence");
  setBody("Updated message");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(resourcePatchCalls()).toHaveLength(1));
  await waitFor(() => expect(messagePatchCalls()).toHaveLength(1));
  expect(JSON.parse(resourcePatchCalls()[0][1].body)).toEqual({
    name: "Updated sequence",
    description: "Original description",
  });
  expect(JSON.parse(messagePatchCalls()[0][1].body)).toEqual({ body: "Updated message" });
  expect(await screen.findByText("All changes saved")).toBeInTheDocument();
});

it("keeps failed fields dirty and retries only those fields", async () => {
  const user = userEvent.setup();
  rejectBodyPatch = true;
  renderEditor();
  const name = await screen.findByPlaceholderText("Sequence name");
  await user.clear(name);
  await user.type(name, "Updated sequence");
  setBody("Updated message");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Couldn't save — retry")).toBeInTheDocument();
  expect(resourcePatchCalls()).toHaveLength(1);
  rejectBodyPatch = false;
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("All changes saved");
  expect(resourcePatchCalls()).toHaveLength(1);
  expect(messagePatchCalls()).toHaveLength(2);
});

it("keeps newer typing dirty when an older save snapshot finishes", async () => {
  const user = userEvent.setup();
  const pending = deferred<ResourceMessage>();
  bodyPatchPromise = pending.promise;
  renderEditor();
  await screen.findByPlaceholderText("What you want them to read.");
  setBody("Submitted snapshot");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  setBody("Newer local draft");
  pending.resolve(message({ body: "Submitted snapshot" }));
  expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
});
```

Add literal helpers that distinguish reads from PATCH calls:

```tsx
function resourcePatchCalls() {
  return api.mock.calls.filter(
    ([path, options]) => path === "/resources/resource-1" && options?.method === "PATCH",
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
```

- [ ] **Step 3: Write shortcut, validation, and navigation RED tests**

Change the existing boundary tests to click Save rather than blur, then add:

```tsx
it.each([
  ["Meta", { metaKey: true }],
  ["Control", { ctrlKey: true }],
])("saves with %s+S", async (_label, modifier) => {
  renderEditor();
  await screen.findByPlaceholderText("What you want them to read.");
  setBody("Shortcut draft");
  const event = new KeyboardEvent("keydown", {
    key: "s",
    bubbles: true,
    cancelable: true,
    ...modifier,
  });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => expect(messagePatchCalls()).toHaveLength(1));
  expect(JSON.parse(messagePatchCalls()[0][1].body)).toEqual({ body: "Shortcut draft" });
});

it("disables save and keeps an over-limit draft local", async () => {
  renderEditor();
  await screen.findByPlaceholderText("What you want them to read.");
  setBody("x".repeat(1001));
  expect(screen.getByText("Needs attention — message too long")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(messagePatchCalls()).toHaveLength(0);
});

it("disables save for a blank sequence name", async () => {
  const user = userEvent.setup();
  renderEditor();
  const name = await screen.findByPlaceholderText("Sequence name");
  await user.clear(name);
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
});

it("disables save while the submitted snapshot is in flight", async () => {
  const user = userEvent.setup();
  const pending = deferred<ResourceMessage>();
  bodyPatchPromise = pending.promise;
  renderEditor();
  await screen.findByPlaceholderText("What you want them to read.");
  setBody("Pending body");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(screen.getByText("Saving…")).toBeInTheDocument();
  pending.resolve(message({ body: "Pending body" }));
  expect(await screen.findByText("All changes saved")).toBeInTheDocument();
});

it("asks before leaving with an unsaved draft", async () => {
  const user = userEvent.setup();
  renderEditor();
  await screen.findByPlaceholderText("What you want them to read.");
  setBody("Unsaved body");
  await user.click(screen.getByRole("link", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByPlaceholderText("What you want them to read.")).toHaveValue("Unsaved body");
  await user.click(screen.getByRole("link", { name: "Back" }));
  await user.click(screen.getByRole("button", { name: "Leave without saving" }));
  expect(await screen.findByText("Sequences page")).toBeInTheDocument();
});
```

- [ ] **Step 4: Run the editor suite and verify RED**

Run:

```bash
npm --prefix web test -- src/pages/SequenceEditor.test.tsx
```

Expected: failures show the old blur-autosave behavior, missing Save changes button, missing dirty status, and unguarded navigation.

- [ ] **Step 5: Move authored-text baselines into the editor**

Add saved resource and message-body baselines and derive dirty targets from values rather than mutation history:

```tsx
const [savedResource, setSavedResource] = useState({
  name: resource.name,
  description: resource.description ?? "",
});
const [savedBodies, setSavedBodies] = useState<Record<string, string | null>>(() =>
  Object.fromEntries(initialMessages.map((message) => [message.id, message.body])),
);

const dirtyResource = name !== savedResource.name || description !== savedResource.description;
const dirtyMessages = items.filter(
  (message) => (message.body ?? null) !== (savedBodies[message.id] ?? null),
);
const dirty = dirtyResource || dirtyMessages.length > 0;
```

On add/delete success, add or remove the corresponding saved-body entry. Remove body persistence from `SortableStep` blur handling; retain its media upload PATCH mutation.

- [ ] **Step 6: Implement partial-safe text persistence**

Build an immutable snapshot of dirty targets and run the existing PATCH calls concurrently. Convert every outcome into `TextSaveResult` so successful baselines advance even when another field fails:

```tsx
const results = await Promise.all(
  targets.map(async (target): Promise<TextSaveResult> => {
    try {
      if (target.kind === "resource") {
        await api(`/resources/${id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: target.name,
            description: target.description || null,
          }),
        });
      } else {
        await api(`/messages/${target.id}`, {
          method: "PATCH",
          body: JSON.stringify({ body: target.body }),
        });
      }
      return { target, ok: true };
    } catch (error) {
      return { target, ok: false, error };
    }
  }),
);
```

In `onSuccess`, advance baselines only for `ok: true` targets, preserve failed drafts, set `saveFailed`, mark server length failures inline by `MESSAGE_BODY_TOO_LONG_ERROR`, invalidate successful query families, and toast only safe generic/API messages.

- [ ] **Step 7: Implement the Save UI, status, shortcut, and guards**

Render `SaveStatus` and the primary button together in the header. Derive `saving` with `useIsMutating({ mutationKey: saveKey })`; block Save for clean, saving, blank-name, or over-limit states. Install a window keydown effect that recognizes `event.key.toLowerCase() === "s"` plus `metaKey` or `ctrlKey`, calls `preventDefault()`, and invokes the same `saveDrafts` callback.

Update status precedence to:

```ts
saving
  ? "saving"
  : needsAttention
    ? "attention"
    : saveFailed || latestImmediateMutationFailed
      ? "error"
      : dirty
        ? "dirty"
        : "saved";
```

Call `useUnsavedChangesGuard(dirty || saving)` and render the existing `ConfirmDialog` when blocked:

```tsx
<ConfirmDialog
  open={blocker.state === "blocked"}
  title="Discard unsaved changes?"
  description="Your latest sequence edits have not finished saving."
  confirmLabel="Leave without saving"
  destructive
  onCancel={() => blocker.state === "blocked" && blocker.reset()}
  onConfirm={() => blocker.state === "blocked" && blocker.proceed()}
/>
```

- [ ] **Step 8: Verify GREEN, mutation-check, and commit**

Run:

```bash
npm --prefix web test -- src/hooks/useUnsavedChangesGuard.test.tsx src/pages/SequenceEditor.test.tsx
npm --prefix web run build
git diff --check
```

Expected: focused tests and build pass.

Temporarily remove and restore each production condition, verifying the named test fails:

- remove dirty-state comparison;
- allow over-limit Save;
- omit keyboard `preventDefault()`;
- advance a message baseline to current text rather than the submitted snapshot;
- call `useUnsavedChangesGuard(false)`.

Commit:

```bash
git add web/src/components/SaveStatus.tsx web/src/pages/SequenceEditor.tsx web/src/pages/SequenceEditor.test.tsx
git commit -m "feat: save authored sequence changes explicitly"
```

### Task 3: Full web verification

**Files:**
- Verify only; modify production or tests only if a regression exposes a scoped defect through a new failing test.

**Interfaces:**
- Consumes the completed navigation guard and explicit save workflow.
- Produces a verified clean branch suitable for review.

- [ ] **Step 1: Run the full web matrix**

```bash
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
```

Expected: every web test passes, lint exits 0, and the production build exits 0.

- [ ] **Step 2: Run repository hygiene checks**

```bash
git diff --check HEAD~2..HEAD
git status --short
```

Expected: no whitespace errors and no uncommitted files.

- [ ] **Step 3: Review the final diff against the design**

Confirm the diff contains no backend changes, structural actions still persist immediately, text blur performs no request, Save and the keyboard shortcut share one path, the 1,000-unit policy is imported rather than duplicated, partial failures retain dirty fields, and navigation protection is active only while dirty or saving.
