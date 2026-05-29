import { Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { supabase, publicMediaUrl } from "../lib/supabase.js";
import { env } from "../config/env.js";

export const uploadRouter = Router();

const allowedKinds = ["image", "pdf"] as const;

const signSchema = z.object({
  kind: z.enum(allowedKinds),
  filename: z.string().min(1).max(200),
});

uploadRouter.post("/sign", async (req, res) => {
  const parsed = signSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { kind, filename } = parsed.data;

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const safeExt = /^[a-z0-9]{1,8}$/.test(ext) ? ext : kind === "pdf" ? "pdf" : "jpg";
  const id = crypto.randomUUID();
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
