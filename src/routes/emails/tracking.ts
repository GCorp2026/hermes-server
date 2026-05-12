import { db } from "../../db";
import { corsHeaders } from "../auth";
import { json, error, PIXEL } from "./core";

// Track email open (GET /api/track-email-open?id=xxx)
export async function handleTrackEmailOpen(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const url = new URL(req.url);
  const emailId = url.searchParams.get("id");

  if (emailId) {
    try {
      await db`UPDATE public.hermes_email_history SET last_event = 'opened' WHERE id = ${emailId}`.execute();
    } catch {}
  }

  return new Response(PIXEL, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate", "Access-Control-Allow-Origin": "*" },
  });
}

// Track email click (GET /api/track-email-click?id=xxx&url=yyy)
export async function handleTrackEmailClick(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const url = new URL(req.url);
  const emailId = url.searchParams.get("id");
  const redirectUrl = url.searchParams.get("url");

  if (emailId) {
    try {
      await db`UPDATE public.hermes_email_history SET last_event = 'clicked' WHERE id = ${emailId}`.execute();
    } catch {}
  }

  if (redirectUrl) return Response.redirect(redirectUrl, 302);
  return error("Missing url parameter");
}
