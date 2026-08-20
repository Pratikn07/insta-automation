import { apiMutation } from "./api";
import { MutationOutcomeUnknownError } from "./mutationOutcome";
import { RequestTimeoutError, withDeadline } from "./requestDeadline";
import type { SignedUpload } from "./types";

/**
 * Uploading one file, once.
 *
 * A PUT to object storage is the least forgiving mutation in the console: the
 * response can be lost while the object lands, and the object is what a guide's
 * media URL will point at. The old code minted a fresh path per attempt, so a
 * retry could not tell whether the first attempt had stored anything — it just
 * wrote somewhere else.
 *
 * Here one upload intent owns one UUID and therefore one object path for its whole
 * life. When a PUT's outcome is unknown, the question is answered by looking: HEAD
 * the public URL and compare size and content type. A confirmed 404 is the only
 * licence to send the bytes again, and a HEAD that *fails* is not a 404 — "I could
 * not look" and "it is not there" are different answers, and treating the first as
 * the second is how a half-written object gets silently overwritten or a good one
 * gets uploaded twice.
 */

const PUT_TIMEOUT_MS = 120_000;

export type UploadReconciliation =
  /** The object is there and matches the file. Nothing more to do. */
  | { status: "confirmed"; publicUrl: string }
  /** The object is definitely absent. Sending the same path again is safe. */
  | { status: "absent" }
  /** Storage answered something else, or not at all. Do not act. */
  | { status: "still_unknown" }
  /** Something is at the path, but it is not this file. */
  | { status: "mismatched" };

export interface SignedUploadDeps {
  /** Injected for tests; defaults to the real signing route and `fetch`. */
  sign?: (input: { id: string; kind: string; filename: string }) => Promise<SignedUpload>;
  put?: (url: string, init: RequestInit) => Promise<Response>;
  head?: (url: string) => Promise<Response>;
}

function defaultSign(input: { id: string; kind: string; filename: string }) {
  return apiMutation<SignedUpload>("/upload/sign", {
    method: "POST",
    operationId: input.id,
    body: JSON.stringify(input),
  });
}

/**
 * Ask storage what is actually at the path.
 *
 * Only a 404 counts as absence, and only a 200 whose size and type match counts as
 * this file. Everything else — a 403, a 500, a network failure — leaves the
 * question open on purpose.
 */
export async function reconcileUpload(
  publicUrl: string,
  file: { size: number; type: string },
  deps: SignedUploadDeps = {},
): Promise<UploadReconciliation> {
  const head = deps.head ?? ((url: string) => fetch(url, { method: "HEAD" }));
  let res: Response;
  try {
    res = await head(publicUrl);
  } catch {
    return { status: "still_unknown" };
  }

  if (res.status === 404) return { status: "absent" };
  if (!res.ok) return { status: "still_unknown" };

  const length = res.headers.get("content-length");
  const type = res.headers.get("content-type");
  // Without a length we cannot claim a match; refusing to guess is the point.
  if (length === null) return { status: "still_unknown" };
  if (Number(length) !== file.size) return { status: "mismatched" };
  if (type !== null && file.type !== "" && type !== file.type) return { status: "mismatched" };
  return { status: "confirmed", publicUrl };
}

export interface UploadAttemptResult {
  status: "uploaded" | "unknown";
  publicUrl: string;
}

/**
 * Sign the intent's path and PUT the file to it.
 *
 * The path is a function of `uploadId` alone, so calling this again with the same
 * id targets the same object rather than a new one. An unknown outcome is reported,
 * never retried here — the caller reconciles and decides.
 */
export async function uploadSignedFile(
  input: { uploadId: string; kind: "image" | "pdf"; file: File },
  deps: SignedUploadDeps = {},
): Promise<UploadAttemptResult> {
  const sign = deps.sign ?? defaultSign;
  const put = deps.put ?? ((url: string, init: RequestInit) => fetch(url, init));

  const signed = await sign({
    id: input.uploadId,
    kind: input.kind,
    filename: input.file.name,
  });

  const deadline = withDeadline(undefined, PUT_TIMEOUT_MS);
  try {
    const res = await put(signed.signedUrl, {
      method: "PUT",
      headers: { "content-type": input.file.type, "x-upsert": "true" },
      body: input.file,
      signal: deadline.signal,
    });
    // A 5xx from storage says nothing about whether the object landed.
    if (res.status >= 500) return { status: "unknown", publicUrl: signed.publicUrl };
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return { status: "uploaded", publicUrl: signed.publicUrl };
  } catch (error) {
    // The bytes were in flight, so the outcome is genuinely open.
    if (
      error instanceof RequestTimeoutError ||
      error instanceof MutationOutcomeUnknownError ||
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      return { status: "unknown", publicUrl: signed.publicUrl };
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}
