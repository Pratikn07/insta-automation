import { mkdir, rename, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "./config.js";

/**
 * Remembers WHICH app-server thread is the advisor's, across restarts.
 *
 * Only a thread id — no message content, no credentials. The conversation itself
 * lives in app-server; this file is the pointer to it, so a Railway redeploy does
 * not silently start the owner a new empty chat.
 *
 * Written to a temp file then atomically renamed, so a crash mid-write leaves the
 * previous pointer intact rather than a truncated file. Mode 0o600 because it sits
 * on the same volume as the ChatGPT credentials.
 */
export interface StoredAdvisorSession {
  schemaVersion: 1;
  threadId: string;
  updatedAt: string;
}

export interface AdvisorSessionStore {
  read(): Promise<string | null>;
  write(threadId: string): Promise<void>;
}

const FILE_NAME = "tinysoho-advisor-session.json";

export function createAdvisorSessionStore(config: RuntimeConfig): AdvisorSessionStore {
  const filePath = path.join(config.CODEX_HOME, FILE_NAME);

  return {
    async read(): Promise<string | null> {
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<StoredAdvisorSession>;
        // A malformed or future-versioned file starts a FRESH thread rather than
        // throwing — and is never deleted, so app-server history is untouched and
        // the bad file remains inspectable.
        if (parsed.schemaVersion !== 1) return null;
        if (typeof parsed.threadId !== "string" || parsed.threadId.length === 0) return null;
        return parsed.threadId;
      } catch {
        return null;
      }
    },

    async write(threadId: string): Promise<void> {
      await mkdir(config.CODEX_HOME, { recursive: true });
      const document: StoredAdvisorSession = {
        schemaVersion: 1,
        threadId,
        updatedAt: new Date().toISOString(),
      };
      const tempPath = `${filePath}.tmp`;
      await writeFile(tempPath, JSON.stringify(document), { mode: 0o600 });
      await rename(tempPath, filePath);
    },
  };
}
