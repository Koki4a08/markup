// Supabase Edge Function entry (Deno). Deploy with --no-verify-jwt: Supabase Auth calls it with a
// Standard Webhooks signature, not a user JWT, and the handler verifies that signature itself.
import { handleSendEmailHook } from './handler.ts';

Deno.serve((req) => handleSendEmailHook(req, { env: (name) => Deno.env.get(name) }));
