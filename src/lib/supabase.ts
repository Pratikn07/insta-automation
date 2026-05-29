import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

export function publicMediaUrl(path: string): string {
  const { data } = supabase.storage.from(env.SUPABASE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
