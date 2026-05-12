import { db } from '../db';

function json(data: unknown, status = 200) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  };
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

// GET /api/auth/work-emails
export async function handleGetWorkEmails(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const workEmails = await db`SELECT id, user_id, work_email, display_name, is_primary, created_at FROM public.hermes_work_emails WHERE user_id = ${userId} ORDER BY created_at DESC`.execute();
    return json({ work_emails: workEmails });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// GET /api/auth/email-history
export async function handleGetEmailHistory(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const url = new URL(req.url);
    const workEmailId = url.searchParams.get("work_email_id");
    if (!workEmailId) return json({ error: "work_email_id required" }, 400);
    const [workEmail] = await db`SELECT id FROM public.hermes_work_emails WHERE id = ${workEmailId} AND user_id = ${userId}`.execute();
    if (!workEmail) return json({ error: "Not found" }, 404);
    const history = await db`SELECT id, work_email_id, direction, from_address, to_addresses, cc_addresses, bcc_addresses, subject, content, html_content, status, last_event, attachments, resend_email_id, created_at FROM public.hermes_email_history WHERE work_email_id = ${workEmailId} ORDER BY created_at DESC LIMIT 100`.execute();
    return json({ history });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// GET /api/email-history (recent activity)
export async function handleEmailHistoryRecent(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam) : 20;
    const history = await db`SELECT eh.id, eh.work_email_id, eh.direction, eh.from_address, eh.to_addresses, eh.subject, eh.content, eh.created_at
      FROM public.hermes_email_history eh
      JOIN public.hermes_work_emails ea ON ea.id = eh.work_email_id
      WHERE ea.user_id = ${userId}
      ORDER BY eh.created_at DESC
      LIMIT ${limit}`.execute();
    return json(history);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// DELETE /api/auth/email-history/:id
export async function handleDeleteEmailHistory(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.pathname.split('/').pop();
    if (!id) return json({ error: 'id required' }, 400);
    await db`DELETE FROM public.hermes_email_history WHERE id = ${id}`.execute();
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/email-history/:id/refetch
export async function handleRefetchEmailContent(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[parts.length - 2];
    if (!id) return json({ error: "id required" }, 400);
    const [record] = await db`SELECT eh.id, eh.resend_email_id, eh.work_email_id, ea.user_id
      FROM public.hermes_email_history eh
      JOIN public.hermes_work_emails ea ON ea.id = eh.work_email_id
      WHERE eh.id = ${id}`.execute();
    if (!record) return json({ error: "Not found" }, 404);
    if (record.user_id !== userId) return json({ error: "Forbidden" }, 403);
    if (!record.resend_email_id) return json({ error: "No resend_email_id" }, 400);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(record.resend_email_id)) {
      return json({ success: true, skipped: true, reason: "not a real Resend ID" });
    }
    const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
    if (!RESEND_API_KEY) return json({ error: "Resend not configured" }, 500);
    const resendRes = await fetch(`https://api.resend.com/emails/receiving/${record.resend_email_id}`, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    });
    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error("Resend fetch error", resendRes.status, errText);
      return json({ error: "Failed to fetch from Resend" }, 500);
    }
    const emailData = await resendRes.json();
    await db`UPDATE public.hermes_email_history SET content = ${emailData.text || null}, html_content = ${emailData.html || null} WHERE id = ${id}`.execute();
    return json({ success: true, content: emailData.text || null, html_content: emailData.html || null });
  } catch (e: any) {
    console.error("handleRefetchEmailContent error:", e);
    return json({ error: e.message || "Internal error" }, 500);
  }
}
