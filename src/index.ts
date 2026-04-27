import { corsHeaders } from './routes/auth';
import * as emails from './routes/emails';
import * as contacts from './routes/contacts';
import { db } from './db';
import { handleAdminListUsers, handleAdminSetRole } from './routes';

const PORT = parseInt(process.env.PORT || '3001');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || 'hermes-dev-secret-2024';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

const PIXEL = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02]);

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\\/g, '/').replace(/\\/+/g, '/');
  const segments = path.split('/').filter(Boolean);
  const resource = segments[0];

  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (path === '/pixel.gif' || path === '/track') {
    return new Response(PIXEL, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' } });
  }

  if (resource === 'hooks' && segments[1] === 'email' && req.method === 'POST') {
    const { db } = await import('./db');
    try {
      const body = await req.json();
      if (body.type === 'email.received') {
        const { from, subject, text, html } = body.payload;
        await db`INSERT INTO emails (sender, subject, body_text, body_html, status, received_at) VALUES (${from}, ${subject}, ${text || ''}, ${html || ''}, 'received', NOW())`.execute();
      }
      return json({ ok: true });
    } catch { return json({ error: 'bad_request' }, 400); }
  }

  if (resource === 'functions' && segments[1] === 'v1' && segments[2] === 'track-email-open' && req.method === 'GET') {
    const emailId = url.searchParams.get('id');
    if (emailId) await db`UPDATE email_logs SET opened = opened + 1, last_opened_at = NOW() WHERE id = ${emailId}`.execute();
    return new Response(PIXEL, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' } });
  }

  if (resource === 'functions' && segments[1] === 'v1' && segments[2] === 'track-email-click' && req.method === 'GET') {
    const linkId = url.searchParams.get('id');
    if (linkId) await db`INSERT INTO email_link_clicks (link_id, clicked_at) VALUES (${linkId}, NOW()) ON CONFLICT DO NOTHING`.execute();
    const redirect = url.searchParams.get('url');
    if (redirect) return Response.redirect(redirect, 302);
    return json({ ok: true });
  }

  if (resource === 'functions' && segments[1] === 'v1' && segments[2] === 'process-scheduled-emails' && req.method === 'POST') {
    const now = new Date().toISOString();
    const scheduled = await db`SELECT * FROM scheduled_emails WHERE status = 'pending' AND scheduled_at <= ${now} LIMIT 10`.execute();
    if (!scheduled.length) return json({ success: true, processed: 0 });
    let processed = 0;
    for (const email of scheduled) {
      const [workEmail] = await db`SELECT * FROM work_emails WHERE id = ${email.work_email_id}`.execute();
      if (!workEmail) continue;
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: workEmail.email, to: email.recipient, subject: email.subject, html: email.body }),
        });
        await db`UPDATE scheduled_emails SET status = 'sent', sent_at = NOW() WHERE id = ${email.id}`.execute();
        processed++;
      } catch { await db`UPDATE scheduled_emails SET status = 'failed' WHERE id = ${email.id}`.execute(); }
    }
    return json({ success: true, processed });
  }

  if (resource === 'api') {
    const pathParts = segments.slice(1);
    if (pathParts.length < 2) return error('Invalid path');
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
    let userId: string;
    try { userId = require('jsonwebtoken').verify(authHeader.split(' ')[1], JWT_SECRET).userId; } catch { return json({ error: 'Invalid token' }, 401); }

    // Admin routes
    if (pathParts[0] === 'auth' && pathParts[1] === 'admin') {
      const roles = await db`SELECT role FROM public.user_roles WHERE user_id = ${userId}`.execute();
      const isAdmin = roles.some((r: any) => r.role === 'admin' || r.role === 'super');
      if (!isAdmin) return json({ error: 'Forbidden' }, 403);
      if (pathParts[2] === 'users' && req.method === 'GET') return handleAdminListUsers(req);
      if (pathParts[2] === 'set-role' && req.method === 'POST') return handleAdminSetRole(req);
      return error('Not found', 404);
    }

    // User-roles
    if (pathParts[0] === 'auth' && pathParts[1] === 'user-roles' && req.method === 'GET') {
      const targetUserId = pathParts[2] || userId;
      const roles = await db`SELECT role FROM public.user_roles WHERE user_id = ${targetUserId}`.execute();
      return json({ roles: roles.map((r: any) => r.role) });
    }
    if (pathParts[0] === 'auth' && pathParts[1] === 'me' && req.method === 'GET') {
      const [user] = await db`SELECT id, email, full_name FROM hermes_users WHERE id = ${userId}`.execute();
      const roles = await db`SELECT role FROM public.user_roles WHERE user_id = ${userId}`.execute();
      return json({ user: { ...user, roles: roles.map((r: any) => r.role) } });
    }

    // Contacts
    if (pathParts[0] === 'contacts') {
      if (pathParts[1] === 'industries' && req.method === 'GET') return contacts.handleIndustries(req);
      if (req.method === 'GET') return contacts.listContacts(req, userId);
      if (req.method === 'POST') return contacts.createContact(req, userId);
      if (req.method === 'PUT' && pathParts[1]) return contacts.updateContact(req, pathParts[1], userId);
      if (req.method === 'DELETE' && pathParts[1]) return contacts.deleteContact(req, pathParts[1], userId);
    }

    // Emails
    if (pathParts[0] === 'emails') {
      if (req.method === 'GET' && pathParts[1] === 'templates') return emails.listTemplates(req, userId);
      if (req.method === 'POST' && pathParts[1] === 'templates') return emails.createTemplate(req, userId);
      if (req.method === 'PUT' && pathParts[1] === 'templates' && pathParts[2]) return emails.updateTemplate(req, pathParts[2], userId);
      if (req.method === 'DELETE' && pathParts[1] === 'templates' && pathParts[2]) return emails.deleteTemplate(req, pathParts[2], userId);
      if (req.method === 'POST' && pathParts[1] === 'send') return emails.sendEmail(req, userId);
      if (req.method === 'GET' && pathParts[1] === 'history') return emails.getHistory(req, userId);
    }

    return error('Not found', 404);
  }

  if (resource === 'auth') {
    if (segments[1] === 'login' && req.method === 'POST') {
      const { email, password } = await req.json().catch(() => ({}));
      const users = await db`SELECT id, email, password_hash, full_name FROM hermes_users WHERE email = ${email}`.execute();
      if (!users.length) return json({ error: 'Invalid credentials' }, 401);
      const valid = await Bun.password.verify(password, users[0].password_hash);
      if (!valid) return json({ error: 'Invalid credentials' }, 401);
      const roles = await db`SELECT role FROM public.user_roles WHERE user_id = ${users[0].id}`.execute();
      const role = roles.find((r: any) => r.role === 'admin') ? 'admin' : (roles[0]?.role || 'user');
      const token = require('jsonwebtoken').sign({ userId: users[0].id, email: users[0].email, role }, JWT_SECRET, { expiresIn: '7d' });
      return json({ token, user: { id: users[0].id, email: users[0].email, full_name: users[0].full_name, role } });
    }
    if (segments[1] === 'register' && req.method === 'POST') {
      const { email, password, full_name } = await req.json().catch(() => ({}));
      if (!email || !password) return json({ error: 'email and password required' }, 400);
      const hash = await Bun.password.hash(password);
      try {
        const [user] = await db`INSERT INTO hermes_users (email, password_hash, full_name) VALUES (${email}, ${hash}, ${full_name || ''}) RETURNING id, email, full_name`.execute();
        await db`INSERT INTO public.user_roles (user_id, role) VALUES (${user.id}, 'user')`.execute();
        const token = require('jsonwebtoken').sign({ userId: user.id, email: user.email, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
        return json({ token, user: { id: user.id, email: user.email, full_name: user.full_name, role: 'user' } });
      } catch (e: any) { return json({ error: e.message }, 400); }
    }
  }

  return error('Not found', 404);
}

const server = Bun.serve({ port: PORT, fetch: route });
console.log(`Hermes Server running on port ${PORT}`);
