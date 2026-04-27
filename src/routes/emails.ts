import { db } from "../db";
import { verifyAuth, corsHeaders, getUserId } from "./auth";

const PIXEL = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]);
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

// GET /api/work-emails
export async function handleWorkEmails(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const [row] = await db`SELECT * FROM work_emails WHERE id = ${id} AND user_id = ${userId}`.execute();
    return json(row || null);
  }

  const rows = await db`SELECT * FROM work_emails WHERE user_id = ${userId} ORDER BY created_at DESC`.execute();
  return json(rows);
}

// POST /api/work-emails
export async function createWorkEmail(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { work_email, display_name } = await req.json();
  if (!work_email) return error("work_email is required");

  const [row] = await db`INSERT INTO work_emails (user_id, work_email, display_name) VALUES (${userId}, ${work_email}, ${display_name || null}) RETURNING *`.execute();
  return json(row, 201);
}

// GET /api/email-history?work_email_id=xxx
export async function handleEmailHistory(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const workEmailId = url.searchParams.get("work_email_id");

  if (!workEmailId) return error("work_email_id is required");

  // Verify user owns this work email
  const [we] = await db`SELECT id FROM work_emails WHERE id = ${workEmailId} AND user_id = ${userId}`.execute();
  if (!we) return error("Work email not found", 404);

  const rows = await db`SELECT * FROM email_history WHERE work_email_id = ${workEmailId} ORDER BY created_at DESC`.execute();
  return json(rows);
}

// GET /api/email-labels
export async function handleEmailLabels(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const rows = await db`SELECT * FROM email_labels WHERE user_id = ${userId} ORDER BY name`.execute();
  return json(rows);
}

// POST /api/email-labels
export async function createEmailLabel(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { name, color } = await req.json();
  if (!name) return error("name is required");

  const [row] = await db`INSERT INTO email_labels (user_id, name, color) VALUES (${userId}, ${name}, ${color || '#000000'}) RETURNING *`.execute();
  return json(row, 201);
}

// DELETE /api/email-labels/:id
export async function deleteEmailLabel(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;
  await db`DELETE FROM email_labels WHERE id = ${id} AND user_id = ${userId}`.execute();
  return json({ success: true });
}

// GET /api/email-label-assignments
export async function handleLabelAssignments(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const rows = await db`SELECT ela.* FROM email_label_assignments ela JOIN work_emails we ON ela.work_email_id = we.id WHERE we.user_id = ${userId}`.execute();
  return json(rows);
}

// POST /api/email-label-assignments
export async function createLabelAssignment(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { email_history_id, label_id } = await req.json();
  if (!email_history_id || !label_id) return error("email_history_id and label_id required");

  // Verify ownership via work_email
  const [assignment] = await db`
    INSERT INTO email_label_assignments (email_history_id, label_id)
    SELECT ${email_history_id}, ${label_id}
    WHERE EXISTS (SELECT 1 FROM email_labels WHERE id = ${label_id} AND user_id = ${userId})
    RETURNING *
  `.execute();

  return json(assignment || { error: "Failed to create assignment" }, assignment ? 201 : 400);
}

// DELETE /api/email-label-assignments?email_history_id=xxx&label_id=yyy
export async function deleteLabelAssignment(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const emailHistoryId = url.searchParams.get("email_history_id");
  const labelId = url.searchParams.get("label_id");

  await db`DELETE FROM email_label_assignments WHERE email_history_id = ${emailHistoryId} AND label_id = ${labelId}`.execute();
  return json({ success: true });
}

// GET /api/scheduled-emails
export async function handleScheduledEmails(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const rows = await db`
    SELECT se.* FROM scheduled_emails se
    JOIN work_emails we ON se.work_email_id = we.id
    WHERE we.user_id = ${userId}
    ORDER BY se.scheduled_at DESC
  `.execute();
  return json(rows);
}

// POST /api/send-email (direct send, not scheduled)
export async function handleSendEmail(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const auth = await verifyAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json();
  const { to, cc, bcc, subject, content, html_content, work_email_id, scheduled_at, attachments } = body;

  if (!to || !subject || !work_email_id) {
    return error("Missing required fields: to, subject, work_email_id");
  }

  // Verify ownership
  const [workEmail] = await db`SELECT * FROM work_emails WHERE id = ${work_email_id} AND user_id = ${auth.userId}`.execute();
  if (!workEmail) return error("Work email not found or unauthorized", 403);

  // Scheduled
  if (scheduled_at) {
    await db`
      INSERT INTO scheduled_emails (work_email_id, scheduled_at, to_addresses, cc_addresses, bcc_addresses, subject, content, html_content, attachments, status)
      VALUES (
        ${work_email_id}, ${scheduled_at},
        ${JSON.stringify(Array.isArray(to) ? to : [to])},
        ${cc ? JSON.stringify(cc) : null},
        ${bcc ? JSON.stringify(bcc) : null},
        ${subject}, ${content || null}, ${html_content || null},
        ${attachments ? JSON.stringify(attachments.map((a: { path: string }) => a.path)) : null},
        'pending'
      )
    `.execute();
    return json({ success: true, scheduled: true });
  }

  // Immediate send
  if (!RESEND_API_KEY) return error("Resend API key not configured", 500);

  const fromAddress = workEmail.display_name
    ? `${workEmail.display_name} <${workEmail.work_email}>`
    : workEmail.work_email;

  const resendPayload: Record<string, unknown> = { from: fromAddress, to: Array.isArray(to) ? to : [to], subject };
  if (html_content) resendPayload.html = html_content;
  else if (content) resendPayload.text = content;
  if (cc?.length) resendPayload.cc = cc;
  if (bcc?.length) resendPayload.bcc = bcc;

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(resendPayload),
  });

  const resendData = await resendRes.json();

  await db`
    INSERT INTO email_history (work_email_id, resend_email_id, direction, from_address, to_addresses, cc_addresses, bcc_addresses, subject, content, html_content, status, error_message, attachments)
    VALUES (
      ${work_email_id}, ${resendData.id || null}, 'sent', ${workEmail.work_email},
      ${JSON.stringify(Array.isArray(to) ? to : [to])},
      ${cc ? JSON.stringify(cc) : null}, ${bcc ? JSON.stringify(bcc) : null},
      ${subject}, ${content || null}, ${html_content || null},
      ${resendRes.ok ? 'sent' : 'failed'},
      ${resendRes.ok ? null : JSON.stringify(resendData)},
      ${attachments ? JSON.stringify(attachments.map((a: { path: string }) => a.path)) : null}
    )
  `.execute();

  if (!resendRes.ok) return error(`Failed to send email: ${JSON.stringify(resendData)}`, 500);
  return json({ success: true, id: resendData.id });
}

// Track email open (GET /api/track-email-open?id=xxx)
export async function handleTrackEmailOpen(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const url = new URL(req.url);
  const emailId = url.searchParams.get("id");

  if (emailId) {
    try {
      await db`UPDATE email_history SET last_event = 'opened' WHERE id = ${emailId}`.execute();
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
      await db`UPDATE email_history SET last_event = 'clicked' WHERE id = ${emailId}`.execute();
    } catch {}
  }

  if (redirectUrl) return Response.redirect(redirectUrl, 302);
  return error("Missing url parameter");
}
