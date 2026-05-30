import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_EMAIL } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env");
  process.exit(1);
}
if (!ADMIN_EMAIL) {
  console.error("Missing ADMIN_EMAIL in .env. Add it before running this script.");
  process.exit(1);
}

// ADMIN_EMAIL may be a comma-separated allowlist. This script mints a token by
// (re)setting a password, so default to the LAST entry (the test/admin account)
// to avoid clobbering the primary user's password. Override with TOKEN_EMAIL.
const allowlist = ADMIN_EMAIL.split(",").map((e) => e.trim()).filter(Boolean);
const targetEmail = process.env.TOKEN_EMAIL?.trim() || allowlist[allowlist.length - 1];

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const password = crypto.randomBytes(24).toString("base64url");

const { data: existing } = await admin.auth.admin.listUsers();
const found = existing?.users.find((u) => u.email?.toLowerCase() === targetEmail.toLowerCase());

if (found) {
  console.error(`User ${targetEmail} already exists; resetting password...`);
  const { error } = await admin.auth.admin.updateUserById(found.id, {
    password,
    email_confirm: true,
  });
  if (error) {
    console.error("Update failed:", error.message);
    process.exit(1);
  }
} else {
  console.error(`Creating user ${targetEmail}...`);
  const { error } = await admin.auth.admin.createUser({
    email: targetEmail,
    password,
    email_confirm: true,
  });
  if (error) {
    console.error("Create failed:", error.message);
    process.exit(1);
  }
}

const anon = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const { data: session, error: signInError } = await anon.auth.signInWithPassword({
  email: targetEmail,
  password,
});

if (signInError || !session.session) {
  console.error("Sign-in failed:", signInError?.message);
  process.exit(1);
}

console.error("\n✅ Got access token. Use it like this:\n");
console.error(`  TOKEN='${session.session.access_token}'`);
console.error(`  curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/me\n`);
console.log(session.session.access_token);
