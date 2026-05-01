import { db } from '../db';
import { signToken, verifyToken } from './jwt';

function json(data: unknown, status = 200) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  };
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

// POST /api/auth/register
export async function handleAuthRegister(req: Request): Promise<Response> {
  try {
    const { email, password, full_name } = await req.json();
    if (!email || !password) return error('email and password required', 400);
    const hash = await Bun.password.hash(password);
    const [user] = await db`INSERT INTO hermes_users (email, password_hash, full_name) VALUES (${email}, ${hash}, ${full_name || ''}) RETURNING id, email, full_name`.execute();
    await db`INSERT INTO public.user_roles (user_id, role, created_at) VALUES (${user.id}, 'user', NOW())`.execute();
    const token = signToken({ userId: user.id, email: user.email, role: 'user' });
    return json({ token, user: { id: user.id, email: user.email, full_name: user.full_name, role: 'user' } });
  } catch (e: any) {
    if (e.message?.includes('duplicate') || e.message?.includes('unique')) return error('Email already registered', 400);
    return error(e.message, 500);
  }
}

// POST /api/auth/login
export async function handleAuthLogin(req: Request): Promise<Response> {
  try {
    const { email, password } = await req.json();
    if (!email || !password) return error('email and password required', 400);
    const users = await db`SELECT id, email, password_hash, full_name FROM hermes_users WHERE email = ${email}`.execute();
    if (!users.length) return error('Invalid credentials', 401);
    const valid = await Bun.password.verify(password, users[0].password_hash);
    if (!valid) return error('Invalid credentials', 401);
    const roles = await db`SELECT role FROM public.user_roles WHERE user_id = ${users[0].id}`.execute();
    const role = roles.find((r: any) => r.role === 'admin' || r.role === 'super') ? 'admin' : (roles[0]?.role || 'user');
    const token = signToken({ userId: users[0].id, email: users[0].email, role });
    return json({ token, user: { id: users[0].id, email: users[0].email, full_name: users[0].full_name, role } });
  } catch (err) {
    console.error('Login error:', err);
    return error('Internal server error', 500);
  }
}

// GET /api/auth/user-roles/:userId
export async function handleGetUserRoles(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const userId = url.pathname.split('/').pop();
    if (!userId) return error('user_id required');
    const roles = await db`SELECT role FROM public.user_roles WHERE user_id = ${userId}`.execute();
    return json({ roles: roles.map((r: any) => r.role) });
  } catch (e: any) {
    return error(e.message);
  }
}

// GET /api/auth/me
export async function handleAuthMe(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const [user] = await db`SELECT id, email, full_name FROM hermes_users WHERE id = ${userId}`.execute();
    if (!user) return error('User not found', 404);
    const roles = await db`SELECT role FROM public.user_roles WHERE user_id = ${userId}`.execute();
    return json({ user: { ...user, roles: roles.map((r: any) => r.role) } });
  } catch (e: any) {
    return error(e.message, 500);
  }
}

// POST /api/auth/promote-to-admin
export async function handlePromoteToAdmin(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const { email } = await req.json();
    if (!email) return error('email required');
    const users = await db`SELECT id FROM hermes_users WHERE email = ${email}`.execute();
    if (!users.length) return error('User not found', 404);
    const targetId = users[0].id;
    if (targetId === userId) return error('Cannot promote yourself', 400);
    await db`INSERT INTO public.user_roles (user_id, role, created_at) VALUES (${targetId}, 'admin', NOW()) ON CONFLICT DO NOTHING`.execute();
    return json({ success: true });
  } catch (e: any) {
    return error(e.message, 500);
  }
}

// GET /api/auth/admin/users — list all users
export async function handleAdminListUsers(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const users = await db`SELECT u.id, u.email, COALESCE(u.full_name, '') as full_name, COALESCE(ur.role, 'user') as role FROM hermes_users u LEFT JOIN public.user_roles ur ON u.id = ur.user_id ORDER BY u.created_at DESC LIMIT 50`.execute();
    return json({ users: users.map(u => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role })) });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/admin/set-role
export async function handleAdminSetRole(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const { user_id, role } = await req.json();
    if (!user_id || !role) return json({ error: 'user_id and role required' }, 400);
    await db`DELETE FROM public.user_roles WHERE user_id = ${user_id}`.execute();
    await db`INSERT INTO public.user_roles (user_id, role, created_at) VALUES (${user_id}::uuid, ${role}::public.app_role, NOW())`.execute();
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// DELETE /api/auth/admin/users/:id
export async function handleAdminDeleteUser(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const url = new URL(req.url);
    const targetId = url.pathname.split('/').pop();
    if (!targetId) return json({ error: 'user_id required' }, 400);
    if (targetId === userId) return json({ error: 'Cannot delete yourself' }, 400);
    await db`DELETE FROM employees WHERE user_id = ${targetId}`.execute();
    await db`DELETE FROM public.user_roles WHERE user_id = ${targetId}`.execute();
    await db`DELETE FROM hermes_users WHERE id = ${targetId}`.execute();
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/admin/users/bulk-delete
export async function handleAdminBulkDelete(req: Request, token: string, adminId: string): Promise<Response> {
  try {
    const { user_ids } = await req.json();
    if (!Array.isArray(user_ids) || !user_ids.length) return json({ error: 'user_ids array required' }, 400);
    const toDelete = user_ids.filter((id: string) => id !== adminId);
    if (!toDelete.length) return json({ success: true, deleted: 0 });
    await db`DELETE FROM employees WHERE user_id = ANY(${toDelete})`.execute();
    await db`DELETE FROM public.user_roles WHERE user_id = ANY(${toDelete})`.execute();
    await db`DELETE FROM hermes_users WHERE id = ANY(${toDelete})`.execute();
    return json({ success: true, deleted: toDelete.length });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/admin/users/bulk-update
export async function handleAdminBulkUpdate(req: Request, token: string, adminId: string): Promise<Response> {
  try {
    const { user_ids, role } = await req.json();
    if (!Array.isArray(user_ids) || !user_ids.length) return json({ error: 'user_ids array required' }, 400);
    if (!role) return json({ error: 'role required' }, 400);
    await db`DELETE FROM public.user_roles WHERE user_id = ANY(${user_ids})`.execute();
    await db`INSERT INTO public.user_roles (user_id, role, created_at) SELECT unnest(${user_ids}::uuid[]), ${role}::public.app_role, NOW()`.execute();
    return json({ success: true, updated: user_ids.length });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// GET /api/auth/admin/email-assignments
export async function handleAdminListEmailAssignments(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const assignments = await db`SELECT id, user_id, email_address, domain, display_name, is_active, work_email, created_at FROM email_assignments ORDER BY created_at DESC LIMIT 100`.execute();
    return json({ assignments });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/admin/email-assignments
export async function handleAdminCreateEmailAssignment(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const { user_id, email_address, domain, display_name } = await req.json();
    if (!user_id || !email_address) return json({ error: 'user_id and email_address required' }, 400);
    await db`INSERT INTO email_assignments (user_id, email_address, domain, display_name, provider, work_email) VALUES (${user_id}::uuid, ${email_address}, ${domain || 'glinskyhq.ru'}, ${display_name || ''}, 'resend', ${email_address})`.execute();
    return json({ success: true });
  } catch (e: any) {
    if (e.message?.includes('duplicate') || e.message?.includes('23505')) return json({ error: 'Email already assigned' }, 400);
    return json({ error: e.message }, 500);
  }
}

// DELETE /api/auth/admin/email-assignments/:id
export async function handleAdminDeleteEmailAssignment(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.pathname.split('/').pop();
    if (!id) return json({ error: 'id required' }, 400);
    await db`DELETE FROM email_assignments WHERE id = ${id}`.execute();
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// GET /api/auth/work-emails — get current user's work emails
export async function handleGetWorkEmails(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const workEmails = await db`SELECT id, user_id, COALESCE(work_email, email_address) as work_email, display_name, is_active, created_at FROM email_assignments WHERE user_id = ${userId} ORDER BY created_at DESC`.execute();
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
    const [workEmail] = await db`SELECT id FROM email_assignments WHERE id = ${workEmailId} AND user_id = ${userId}`.execute();
    if (!workEmail) return json({ error: "Not found" }, 404);
    const history = await db`SELECT id, work_email_id, direction, from_address, to_addresses, cc_addresses, bcc_addresses, subject, content, html_content, status, last_event, attachments, resend_email_id, created_at FROM email_history WHERE work_email_id = ${workEmailId} ORDER BY created_at DESC LIMIT 100`.execute();
    return json({ history });
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
    await db`DELETE FROM email_history WHERE id = ${id}`.execute();
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}


// POST /api/auth/email-history/:id/refetch - fetch missing email content from Resend
export async function handleRefetchEmailContent(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[parts.length - 2];  // second-to-last = UUID
    if (!id) return json({ error: "id required" }, 400);

    const [record] = await db`SELECT eh.id, eh.resend_email_id, eh.work_email_id, ea.user_id
      FROM email_history eh
      JOIN email_assignments ea ON ea.id = eh.work_email_id
      WHERE eh.id = ${id}`.execute();
    if (!record) return json({ error: "Not found" }, 404);
    if (record.user_id !== userId) return json({ error: "Forbidden" }, 403);
    if (!record.resend_email_id) return json({ error: "No resend_email_id" }, 400);

    // Skip synthetic/test resend IDs that are not valid UUIDs
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

    await db`UPDATE email_history
      SET content = ${emailData.text || null},
          html_content = ${emailData.html || null}
      WHERE id = ${id}`.execute();

    return json({ success: true, content: emailData.text || null, html_content: emailData.html || null });
  } catch (e: any) {
    console.error("handleRefetchEmailContent error:", e);
    return json({ error: e.message || "Internal error" }, 500);
  }
}

// POST /api/auth/email-send — equivalent to Supabase send-email edge function
export async function handleHermesEmailSend(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const { to, cc, bcc, subject, content, html_content, work_email_id, scheduled_at, attachments } = await req.json();

    if (!to || !subject || !work_email_id) {
      return json({ error: 'Missing required fields: to, subject, work_email_id' }, 400);
    }

    // Verify user owns this work email
    const [workEmail] = await db`SELECT * FROM email_assignments WHERE id = ${work_email_id} AND user_id = ${userId}`.execute();
    if (!workEmail) {
      return json({ error: 'Work email not found or unauthorized' }, 403);
    }

    const toAddresses = Array.isArray(to) ? to : [to];
    const ccAddresses = cc?.length ? cc : null;
    const bccAddresses = bcc?.length ? bcc : null;
    const attachmentPaths = attachments?.map((a: { path: string }) => a.path) || null;

    // Scheduled send — store in scheduled_emails
    if (scheduled_at) {
      await db`INSERT INTO scheduled_emails (work_email_id, to_addresses, cc_addresses, bcc_addresses, subject, content, html_content, attachments, scheduled_at, status)
        VALUES (${work_email_id}, ${toAddresses}, ${ccAddresses}, ${bccAddresses}, ${subject}, ${content || null}, ${html_content || null}, ${attachmentPaths}, ${scheduled_at}, 'pending')`.execute();
      return json({ success: true, scheduled: true });
    }

    if (!RESEND_API_KEY) {
      return json({ error: 'Resend API key not configured' }, 500);
    }

    // Build from address
    const fromAddress = workEmail.display_name
      ? `${workEmail.display_name} <${workEmail.work_email || workEmail.email_address}>`
      : (workEmail.work_email || workEmail.email_address);

    const resendPayload: Record<string, unknown> = {
      from: fromAddress,
      to: toAddresses,
      subject,
    };
    if (html_content) resendPayload.html = html_content;
    else if (content) resendPayload.text = content;
    if (ccAddresses) resendPayload.cc = ccAddresses;
    if (bccAddresses) resendPayload.bcc = bccAddresses;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify(resendPayload),
    });

    const resendData = await resendRes.json();

    // Store in email_history
    await db`INSERT INTO email_history (id, work_email_id, resend_email_id, direction, from_address, to_addresses, cc_addresses, bcc_addresses, subject, content, html_content, status, error_message, attachments, created_at)
      VALUES (gen_random_uuid(), ${work_email_id}, ${resendData.id || null}, 'sent', ${workEmail.work_email || workEmail.email_address}, ${toAddresses}, ${ccAddresses}, ${bccAddresses}, ${subject}, ${content || null}, ${html_content || null}, ${resendRes.ok ? 'sent' : 'failed'}, ${resendRes.ok ? null : JSON.stringify(resendData)}, ${attachmentPaths}, NOW())`.execute();

    if (!resendRes.ok) {
      return json({ error: 'Failed to send email', details: resendData }, 500);
    }

    return json({ success: true, id: resendData.id });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/process-scheduled — process pending scheduled emails
export async function handleProcessScheduled(req: Request): Promise<Response> {
  try {
    if (!RESEND_API_KEY) {
      return json({ error: 'Resend API key not configured' }, 500);
    }

    const now = new Date().toISOString();
    const pending = await db`SELECT * FROM scheduled_emails WHERE status = 'pending' AND scheduled_at <= ${now} LIMIT 10`.execute();

    const results = [];
    for (const scheduled of pending) {
      const [workEmail] = await db`SELECT * FROM email_assignments WHERE id = ${scheduled.work_email_id}`.execute();
      if (!workEmail) {
        await db`UPDATE scheduled_emails SET status = 'failed', error_message = 'Work email not found' WHERE id = ${scheduled.id}`.execute();
        results.push({ id: scheduled.id, status: 'failed', reason: 'no work email' });
        continue;
      }

      const fromAddress = workEmail.display_name
        ? `${workEmail.display_name} <${workEmail.work_email || workEmail.email_address}>`
        : (workEmail.work_email || workEmail.email_address);

      const resendPayload: Record<string, unknown> = {
        from: fromAddress,
        to: scheduled.to_addresses,
        subject: scheduled.subject,
      };
      if (scheduled.html_content) resendPayload.html = scheduled.html_content;
      else if (scheduled.content) resendPayload.text = scheduled.content;
      if (scheduled.cc_addresses?.length) resendPayload.cc = scheduled.cc_addresses;
      if (scheduled.bcc_addresses?.length) resendPayload.bcc = scheduled.bcc_addresses;

      try {
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify(resendPayload),
        });
        const resendData = await resendRes.json();

        if (resendRes.ok) {
          await db`UPDATE scheduled_emails SET status = 'sent', sent_at = NOW() WHERE id = ${scheduled.id}`.execute();
          await db`INSERT INTO email_history (id, work_email_id, resend_email_id, direction, from_address, to_addresses, cc_addresses, bcc_addresses, subject, content, html_content, status, attachments, created_at)
            VALUES (gen_random_uuid(), ${scheduled.work_email_id}, ${resendData.id || null}, 'sent', ${workEmail.work_email || workEmail.email_address}, ${scheduled.to_addresses}, ${scheduled.cc_addresses}, ${scheduled.bcc_addresses}, ${scheduled.subject}, ${scheduled.content}, ${scheduled.html_content}, 'sent', ${scheduled.attachments}, NOW())`.execute();
          results.push({ id: scheduled.id, status: 'sent' });
        } else {
          await db`UPDATE scheduled_emails SET status = 'failed', error_message = ${JSON.stringify(resendData)} WHERE id = ${scheduled.id}`.execute();
          results.push({ id: scheduled.id, status: 'failed' });
        }
      } catch (sendErr: any) {
        await db`UPDATE scheduled_emails SET status = 'failed', error_message = ${sendErr.message} WHERE id = ${scheduled.id}`.execute();
        results.push({ id: scheduled.id, status: 'failed', error: sendErr.message });
      }
    }

    return json({ processed: results.length, results });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/webhooks/resend — equivalent to Supabase resend-webhook edge function
export async function handleResendWebhook(req: Request): Promise<Response> {
  try {
    const payload = await req.json();
    const type = payload.type;
    let data = payload.data || payload.payload;
    if (!type || !data) return json({ error: 'Invalid webhook payload' }, 400);

    const emailId = data.email_id || data.id;
    if (!emailId) return json({ received: true, skipped: 'no_email_id' });

    let status: string | null = null;
    let lastEvent: string | null = type;
    switch (type) {
      case 'email.sent': status = 'sent'; break;
      case 'email.delivered': status = 'delivered'; break;
      case 'email.bounced': status = 'bounced'; break;
      case 'email.complained': status = 'complained'; break;
      case 'email.delivery_delayed': lastEvent = 'delivery_delayed'; break;
      case 'email.opened': lastEvent = 'opened'; break;
      case 'email.clicked': lastEvent = 'clicked'; break;
    }

    if (status) {
      await db`UPDATE email_history SET last_event = ${lastEvent}, status = ${status} WHERE resend_email_id = ${emailId}`.execute();
    } else if (lastEvent) {
      await db`UPDATE email_history SET last_event = ${lastEvent} WHERE resend_email_id = ${emailId}`.execute();
    }

    if (type === 'email.received') {
      if ((!data.from || !data.to) && RESEND_API_KEY) {
        const recv = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
        });
        if (recv.ok) data = { ...data, ...(await recv.json()) };
      }

      const toRaw = data.to || data.to_addresses || data.recipients;
      const toAddresses = Array.isArray(toRaw) ? toRaw : [toRaw].filter(Boolean);
      const fromAddress = typeof data.from === 'object' ? data.from.email : data.from;
      const matchAddresses = toAddresses.map((a: any) =>
        String(typeof a === 'object' ? a.email : a).toLowerCase()
      );

      if (fromAddress && matchAddresses.length) {
        const [workEmail] = await db`
          SELECT id FROM email_assignments
          WHERE lower(coalesce(work_email, email_address)) = ANY(${matchAddresses})
             OR lower(email_address) = ANY(${matchAddresses})
          LIMIT 1
        `.execute();
        if (workEmail) {
          await db`INSERT INTO email_history (id, work_email_id, resend_email_id, original_email_id, direction, from_address, to_addresses, subject, content, html_content, status, created_at)
            VALUES (gen_random_uuid(), ${workEmail.id}, ${emailId}, ${emailId}, 'received', ${fromAddress}, ${matchAddresses}, ${data.subject || '(no subject)'}, ${data.text || data.text_body || null}, ${data.html || data.html_body || null}, 'received', NOW())
            ON CONFLICT DO NOTHING`.execute();
        }
      }
    }

    return json({ received: true });
  } catch (e: any) {
    console.error('resend webhook error:', e);
    return json({ error: e.message }, 500);
  }
}

// PUT /api/auth/admin/users/:id — update user
export async function handleAdminUpdateUser(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const url = new URL(req.url);
    const targetId = url.pathname.split('/').pop();
    if (!targetId) return json({ error: 'user_id required' }, 400);
    const { full_name, email } = await req.json();
    if (full_name !== undefined) {
      await db`UPDATE hermes_users SET full_name = ${full_name} WHERE id = ${targetId}`.execute();
    }
    if (email !== undefined) {
      await db`UPDATE hermes_users SET email = ${email} WHERE id = ${targetId}`.execute();
    }
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/admin/users/:id/password — reset user password
export async function handleAdminResetPassword(req: Request, token: string, adminId: string): Promise<Response> {
  try {
    const parts = new URL(req.url).pathname.split('/').filter(Boolean);
    const passwordIndex = parts.lastIndexOf('password');
    const targetId = passwordIndex > 0 ? parts[passwordIndex - 1] : '';
    if (!targetId) return json({ error: 'user_id required' }, 400);

    const { password } = await req.json();
    if (typeof password !== 'string' || password.length < 6) {
      return json({ error: 'Password must be at least 6 characters' }, 400);
    }

    const [target] = await db`SELECT id FROM hermes_users WHERE id = ${targetId}`.execute();
    if (!target) return json({ error: 'User not found' }, 404);

    const hash = await Bun.password.hash(password);
    await db`UPDATE hermes_users SET password_hash = ${hash} WHERE id = ${targetId}`.execute();
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}


type TranslateKey = { id: string; text: string; hash?: string };

type TranslateResult = { parsed: Record<string, string>; status: number };

const LANG_NAME: Record<string, string> = { en: 'English', zh: 'Simplified Chinese', tr: 'Turkish' };
const AI_CHUNK_SIZE = 25;
const AI_CONCURRENCY = 3;
const AI_BASE_URL = 'https://api.minimax.io/anthropic/v1';

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function extractJson(content: string): Record<string, string> {
  if (!content) return {};
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {}
  }
  const result: Record<string, string> = {};
  const keyValRe = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = keyValRe.exec(cleaned)) !== null) {
    try {
      result[JSON.parse(`"${m[1]}"`)] = JSON.parse(`"${m[2]}"`) || '';
    } catch {}
  }
  return result;
}

async function doTranslateChunk(chunk: Required<TranslateKey>[], targetLang: string): Promise<TranslateResult> {
  const inputObj: Record<string, string> = {};
  for (const t of chunk) inputObj[t.id] = t.text;

  const systemPrompt = `You are a professional UI translator. Translate each Russian string into ${LANG_NAME[targetLang]}. Preserve placeholders, punctuation, capitalization style, and brand names. Keep translations concise and natural for product UI. Return ONLY a JSON object mapping the same keys to their translated strings.`;
  const userPrompt = `Translate these Russian UI strings to ${LANG_NAME[targetLang]} and return JSON with the same keys:\n${JSON.stringify(inputObj)}`;
  const apiKey = process.env.MINIMAX_API_KEY || '';
  if (!apiKey) return { parsed: {}, status: 503 };

  try {
    const aiResp = await fetch(`${AI_BASE_URL}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.7',
        max_tokens: 8192,
        messages: [{ role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }],
      }),
    });
    if (!aiResp.ok) {
      const errText = await aiResp.text();
      console.error('AI API error', aiResp.status, errText.slice(0, 200));
      return { parsed: {}, status: aiResp.status };
    }
    const aiData: any = await aiResp.json();
    const textBlock = aiData?.content?.find((b: any) => b.type === 'text');
    return { parsed: extractJson(textBlock?.text || ''), status: 200 };
  } catch (e) {
    console.error('translateChunk error', e);
    return { parsed: {}, status: 500 };
  }
}

async function translateChunk(chunk: Required<TranslateKey>[], targetLang: string, retries = 2): Promise<TranslateResult> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await doTranslateChunk(chunk, targetLang);
    if (Object.keys(result.parsed).length > 0 || attempt === retries || result.status === 402 || result.status === 429 || result.status === 503) return result;
    await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
  }
  return { parsed: {}, status: 500 };
}

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx]);
    }
  }));
  return results;
}

// POST /api/translate
export async function handleTranslate(req: Request): Promise<Response> {
  try {
    const { targetLang, keys = [] } = await req.json();
    if (!LANG_NAME[targetLang]) return json({ error: 'Invalid targetLang' }, 400);
    if (!Array.isArray(keys)) return json({ error: 'keys must be an array' }, 400);
    if (keys.length === 0) return json({ translations: {} });

    await db`CREATE TABLE IF NOT EXISTS public.translation_cache (
      source_hash TEXT,
      target_lang TEXT,
      source_text TEXT,
      translated_text TEXT,
      PRIMARY KEY(source_hash, target_lang)
    )`.execute();

    const cleanKeys: TranslateKey[] = keys.filter((k: any) => k && typeof k.id === 'string' && typeof k.text === 'string');
    const hashed = await Promise.all(cleanKeys.map(async k => ({ ...k, hash: await sha256Hex(k.text) } as Required<TranslateKey>)));
    const hashes = hashed.map(h => h.hash);

    const cacheResult = hashes.length
      ? await db`SELECT source_hash, translated_text FROM public.translation_cache WHERE target_lang = ${targetLang} AND source_hash = ANY(${hashes})`.execute()
      : [];
    const cacheMap: Record<string, string> = {};
    for (const r of cacheResult as any[]) cacheMap[r.source_hash] = r.translated_text;

    const translations: Record<string, string> = {};
    const toTranslate: Required<TranslateKey>[] = [];
    for (const k of hashed) {
      if (cacheMap[k.hash]) translations[k.id] = cacheMap[k.hash];
      else toTranslate.push(k);
    }

    let rateLimited = false;
    let creditsExhausted = false;

    if (toTranslate.length > 0 && process.env.MINIMAX_API_KEY) {
      const chunks: Required<TranslateKey>[][] = [];
      for (let i = 0; i < toTranslate.length; i += AI_CHUNK_SIZE) chunks.push(toTranslate.slice(i, i + AI_CHUNK_SIZE));
      const results = await runWithConcurrency(chunks, AI_CONCURRENCY, chunk => translateChunk(chunk, targetLang));
      const rows: { source_hash: string; target_lang: string; source_text: string; translated_text: string }[] = [];

      results.forEach((result, ci) => {
        if (result.status === 429) rateLimited = true;
        if (result.status === 402) creditsExhausted = true;
        const chunk = chunks[ci];
        for (const t of chunk) {
          const val = result.parsed?.[t.id];
          if (typeof val === 'string' && val.length > 0) {
            translations[t.id] = val;
            rows.push({ source_hash: t.hash, target_lang: targetLang, source_text: t.text, translated_text: val });
          }
        }
      });

      if (rows.length > 0) {
        // Deduplicate by (source_hash, target_lang) to prevent ON CONFLICT "cannot affect row twice"
        const seen = new Set<string>();
        const unique: typeof rows = [];
        for (const r of rows) {
          const key = r.source_hash + '||' + r.target_lang;
          if (!seen.has(key)) { seen.add(key); unique.push(r); }
        }
        try {
          if (unique.length === 1) {
            const r = unique[0];
            await db`INSERT INTO public.translation_cache (source_hash, target_lang, source_text, translated_text) VALUES (${r.source_hash}, ${r.target_lang}, ${r.source_text}, ${r.translated_text}) ON CONFLICT (source_hash, target_lang) DO UPDATE SET source_text = EXCLUDED.source_text, translated_text = EXCLUDED.translated_text`.execute();
          } else {
            await db`INSERT INTO public.translation_cache (source_hash, target_lang, source_text, translated_text)
              VALUES ${db(unique.map(r => [r.source_hash, r.target_lang, r.source_text, r.translated_text]))}
              ON CONFLICT (source_hash, target_lang) DO UPDATE SET source_text = EXCLUDED.source_text, translated_text = EXCLUDED.translated_text`.execute();
          }
        } catch (e: any) {
          console.error('Cache insert failed, skipping cache:', e.message);
        }
      }
    }

    const status = rateLimited ? 429 : creditsExhausted ? 402 : 200;
    return json({ translations, rateLimited, creditsExhausted }, status);
  } catch (err) {
    console.error('translate error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}
