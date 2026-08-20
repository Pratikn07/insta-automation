import { z } from "zod";
import { supabase, publicMediaUrl } from "../lib/supabase.js";
import { env } from "../config/env.js";
import { idempotencyKeyMismatch } from "./createReplay.js";
import { asyncRouter } from "./asyncRouter.js";

export const uploadRouter = asyncRouter();

const allowedKinds = ["image", "pdf"] as const;

/**
 * `id` comes from the browser and names the upload intent.
 *
 * It used to be minted here, per call, which made an ambiguous PUT unresolvable:
 * asking for a fresh signature produced a *different* object path, so the client
 * could neither confirm nor overwrite whatever the first attempt may have stored.
 * With the client owning the id, one intent owns exactly one path, and the client
 * can settle the question with a HEAD on the public URL.
 */
const signSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(allowedKinds),
  filename: z.string().min(1).max(200),
});

uploadRouter.post("/sign", async (req, res) => {
  const parsed = signSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { id, kind, filename } = parsed.data;

  if (idempotencyKeyMismatch(req.headers["idempotency-key"], id)) {
    return res.status(400).json({ error: "idempotency_key_mismatch" });
  }

  // The extension is derived, never trusted: only this charset can reach a
  // storage key, so a filename cannot smuggle a path segment into it.
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const safeExt = /^[a-z0-9]{1,8}$/.test(ext) ? ext : kind === "pdf" ? "pdf" : "jpg";
  const path = `${kind}/${id}.${safeExt}`;

  const { data, error } = await supabase.storage
    .from(env.SUPABASE_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) {
    return res.status(500).json({ error: "sign_failed", detail: error?.message });
  }

  res.json({
    path,
    token: data.token,
    signedUrl: data.signedUrl,
    publicUrl: publicMediaUrl(path),
  });
});
