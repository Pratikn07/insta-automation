import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "./config.js";
import { createAdvisorSessionStore } from "./advisorSessionStore.js";

let home: string;
let store: ReturnType<typeof createAdvisorSessionStore>;
const FILE = "tinysoho-advisor-session.json";

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "tinysoho-advisor-"));
  store = createAdvisorSessionStore({
    PORT: 3001,
    NODE_ENV: "test",
    CODEX_HOME: home,
    CODEX_WORKSPACE: path.join(home, "ws"),
    RUNTIME_SHARED_SECRET: "r".repeat(32),
  } as RuntimeConfig);
});

describe("advisorSessionStore", () => {
  it("returns null before anything is written", async () => {
    await expect(store.read()).resolves.toBeNull();
  });

  it("round-trips a thread id", async () => {
    await store.write("thread-abc");
    await expect(store.read()).resolves.toBe("thread-abc");
  });

  it("writes with mode 0600, since it shares the credentials volume", async () => {
    await store.write("thread-abc");
    const info = await stat(path.join(home, FILE));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("stores no message content and no credentials", async () => {
    await store.write("thread-abc");
    const raw = await readFile(path.join(home, FILE), "utf8");
    expect(JSON.parse(raw)).toEqual({
      schemaVersion: 1,
      threadId: "thread-abc",
      updatedAt: expect.any(String),
    });
  });

  it("leaves no temp file behind after an atomic write", async () => {
    await store.write("thread-abc");
    await expect(stat(path.join(home, `${FILE}.tmp`))).rejects.toThrow();
  });

  it("overwrites a previous pointer", async () => {
    await store.write("thread-old");
    await store.write("thread-new");
    await expect(store.read()).resolves.toBe("thread-new");
  });

  // A bad file must not crash the advisor, and must not be deleted — app-server
  // history stays intact and the file remains inspectable.
  it("starts fresh on malformed JSON without deleting the file", async () => {
    const file = path.join(home, FILE);
    await writeFile(file, "{ not json");
    await expect(store.read()).resolves.toBeNull();
    await expect(stat(file)).resolves.toBeTruthy();
  });

  it("starts fresh on an unexpected schema version", async () => {
    await writeFile(
      path.join(home, FILE),
      JSON.stringify({ schemaVersion: 2, threadId: "thread-future" }),
    );
    await expect(store.read()).resolves.toBeNull();
  });

  it("starts fresh when the thread id is missing or empty", async () => {
    const file = path.join(home, FILE);
    await writeFile(file, JSON.stringify({ schemaVersion: 1 }));
    await expect(store.read()).resolves.toBeNull();
    await writeFile(file, JSON.stringify({ schemaVersion: 1, threadId: "" }));
    await expect(store.read()).resolves.toBeNull();
  });

  it("creates CODEX_HOME if it does not exist yet", async () => {
    const nested = path.join(home, "deep", "nested");
    const s = createAdvisorSessionStore({
      PORT: 3001,
      NODE_ENV: "test",
      CODEX_HOME: nested,
      CODEX_WORKSPACE: path.join(nested, "ws"),
      RUNTIME_SHARED_SECRET: "r".repeat(32),
    } as RuntimeConfig);
    await s.write("thread-deep");
    await expect(s.read()).resolves.toBe("thread-deep");
  });
});
