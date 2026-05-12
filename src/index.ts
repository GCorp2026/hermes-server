import { corsHeaders } from "./routes/auth";
import * as emails from "./routes/emails";
import * as contacts from "./routes/contacts";
import { handleSalesProspectsSearch } from "./routes/sales-prospects";
import { handleSalesProspectsEnrich } from "./routes/sales-prospects-enrich";
import { handleAuthMe, handleAuthRegister, handleAuthLogin, handlePromoteToAdmin, handleGetUserRoles, handleAdminListUsers, handleAdminSetRole, handleAdminDeleteUser, handleAdminBulkDelete, handleAdminBulkUpdate, handleAdminUpdateUser, handleAdminResetPassword, handleAdminListEmailAssignments, handleAdminCreateEmailAssignment, handleAdminDeleteEmailAssignment, handleGetWorkEmails, handleGetEmailHistory, handleEmailHistoryRecent, handleDeleteEmailHistory, handleRefetchEmailContent, handleHermesEmailSend, handleProcessScheduled, handleResendWebhook, handleTranslate, handleValidateToken } from "./auth/routes";
import { handleAdminEmails, handleAdminEmailSearch } from "./routes/admin-emails";
import { db } from "./db";

const PORT = parseInt(process.env.PORT || "3001");
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

const PIXEL = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02]);

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\\/g, "/").replace(/\/+/g, "/");
  const segments = path.split("/").filter(Boolean);
  const resource = segments[0];

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (path === "/pixel.gif" || path === "/track") {
    return new Response(PIXEL, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" } });
  }

  // POST email webhooks (Resend)
  if (resource === "hooks" && segments[1] === "email" && req.method === "POST") {
    try {
      const body = await req.json();
      if (body.type === "email.received") {
        const { from, subject, text, html } = body.payload || {};
        await db`INSERT INTO public.hermes_emails (from_address, subject, body, body_html, status, direction, to_addresses, created_at) VALUES (${from || ''}, ${subject || ''}, ${text || ''}, ${html || ''}, 'received', 'inbound', '{}', NOW())`.execute();
      }
      return json({ ok: true });
    } catch { return json({ error: "bad_request" }, 400); }
  }

  // GET /functions/v1/track-email-open
  if (resource === "functions" && segments[1] === "v1" && segments[2] === "track-email-open" && req.method === "GET") {
    const emailId = url.searchParams.get("id");
    if (emailId) await db`UPDATE email_logs SET opened = opened + 1, last_opened_at = NOW() WHERE id = ${emailId}`.execute();
    return new Response(PIXEL, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" } });
  }

  // GET /functions/v1/track-email-click
  if (resource === "functions" && segments[1] === "v1" && segments[2] === "track-email-click" && req.method === "GET") {
    const linkId = url.searchParams.get("id");
    if (linkId) await db`INSERT INTO email_link_clicks (link_id, clicked_at) VALUES (${linkId}, NOW()) ON CONFLICT DO NOTHING`.execute();
    const redirect = url.searchParams.get("url");
    if (redirect) return Response.redirect(redirect, 302);
    return json({ ok: true });
  }

  // POST /functions/v1/process-scheduled-emails
  if (resource === "functions" && segments[1] === "v1" && segments[2] === "process-scheduled-emails" && req.method === "POST") {
    return handleProcessScheduled(req);
  }

  // POST /webhooks/resend
  if (resource === "webhooks" && segments[1] === "resend" && req.method === "POST") {
    return handleResendWebhook(req);
  }

  // API routes
  if (resource === "api") {
    const pathParts = segments.slice(1);
    if (pathParts[0] === "translate" && (req.method === "GET" || req.method === "POST")) return handleTranslate(req);
    if (pathParts.length < 1) return error("Invalid path");

    // Public auth routes (no token required)
    if (pathParts[0] === "auth" && pathParts[1] === "login" && req.method === "POST") return handleAuthLogin(req);
    if (pathParts[0] === "auth" && pathParts[1] === "register" && req.method === "POST") return handleAuthRegister(req);

    // All other auth routes need token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.split(" ")[1];
    const { verifyToken } = await import("./auth/jwt");
    let userId: string;
    try { userId = verifyToken(token, process.env.JWT_SECRET || "hermes-dev-secret-2024").userId; } catch { return json({ error: "Invalid token" }, 401); }

    // Admin email management (accessible as /api/admin/emails)
    if (pathParts[0] === "admin" && pathParts[1] === "emails" && req.method === "GET") return handleAdminEmails(req, userId);
    if (pathParts[0] === "admin" && pathParts[1] === "emails" && pathParts[2] === "search" && req.method === "POST") return handleAdminEmailSearch(req, userId);

    if (pathParts[0] === "auth") {
      const sub = pathParts[1];

      // Admin routes
      if (sub === "admin") {
        const roles = await db`SELECT role FROM public.hermes_user_roles WHERE user_id = ${userId}`.execute();
        const isAdmin = roles.some((r: any) => r.role === "admin" || r.role === "super");
        if (!isAdmin) return json({ error: "Forbidden" }, 403);
        if (pathParts[2] === "users" && req.method === "GET") return handleAdminListUsers(req, token, userId);
        if (pathParts[2] === "set-role" && req.method === "POST") return handleAdminSetRole(req, token, userId);
        if (pathParts[2] === "users" && pathParts[3] && req.method === "DELETE") return handleAdminDeleteUser(req, token, userId);
        if (pathParts[2] === "users" && pathParts[3] === "bulk-delete" && req.method === "POST") return handleAdminBulkDelete(req, token, userId);
        if (pathParts[2] === "users" && pathParts[3] === "bulk-update" && req.method === "POST") return handleAdminBulkUpdate(req, token, userId);
        if (pathParts[2] === "users" && pathParts[3] && pathParts[4] === "password" && req.method === "POST") return handleAdminResetPassword(req, token, userId);
        if (pathParts[2] === "users" && pathParts[3] && req.method === "PUT") return handleAdminUpdateUser(req, token, userId);
        if (pathParts[2] === "email-assignments" && req.method === "GET") return handleAdminListEmailAssignments(req, token, userId);
        if (pathParts[2] === "email-assignments" && req.method === "POST") return handleAdminCreateEmailAssignment(req, token, userId);
        if (pathParts[2] === "email-assignments" && pathParts[3] && req.method === "DELETE") return handleAdminDeleteEmailAssignment(req, token, userId);
        return error("Not found", 404);
      }

      // User routes
      if (sub === "work-emails" && req.method === "GET") return handleGetWorkEmails(req, token, userId);
      if (sub === "email-history" && req.method === "GET") {
        const url = new URL(req.url);
        if (!url.searchParams.get("work_email_id")) {
          return handleEmailHistoryRecent(req, token, userId);
        }
        return handleGetEmailHistory(req, token, userId);
      }
      if (sub === "email-history" && pathParts[2] && pathParts[3] === "refetch" && req.method === "POST") return handleRefetchEmailContent(req, token, userId);
      if (sub === "email-history" && pathParts[2] && req.method === "DELETE") return handleDeleteEmailHistory(req, token, userId);
      if (sub === "email-send" && req.method === "POST") return handleHermesEmailSend(req, token, userId);
      if (sub === "user-roles" && req.method === "GET") {
        const targetUserId = pathParts[2] || userId;
        const roles = await db`SELECT role FROM public.hermes_user_roles WHERE user_id = ${targetUserId}`.execute();
        return json({ roles: roles.map((r: any) => r.role) });
      }
      if (sub === "validate-token" && req.method === "POST") return handleValidateToken(req, token, userId);
      if (sub === "me" && req.method === "GET") return handleAuthMe(req, token, userId);
      if (sub === "promote-to-admin" && req.method === "POST") return handlePromoteToAdmin(req, token, userId);
      return error("Not found", 404);
    }

    // email-history without /auth/ prefix (for frontend recent activity)
    if (pathParts[0] === "email-history" && req.method === "GET") {
      const url = new URL(req.url);
      if (!url.searchParams.get("work_email_id")) {
        return handleEmailHistoryRecent(req, token, userId);
      }
      return error("Not found", 404);
    }

    // Sales Prospects
    if (pathParts[0] === "sales-prospects" && pathParts[1] === "search" && req.method === "POST") {
      return handleSalesProspectsSearch(req);
    }
    if (pathParts[0] === "sales-prospects" && pathParts[1] === "enrich" && req.method === "POST") {
      return handleSalesProspectsEnrich(req);
    }

    // Contacts
    if (pathParts[0] === "contacts") {
      if (pathParts[1] === "industries" && req.method === "GET") return contacts.handleIndustries(req);
      if (pathParts[1] === "users" && req.method === "GET") return contacts.handleContactUsers(req, userId);
      if (req.method === "GET") return contacts.handleContacts(req, userId);
      if (req.method === "POST") return contacts.createContact(req, userId);
      if (req.method === "PUT" && pathParts[1]) return contacts.updateContact(req, userId);
      if (req.method === "DELETE" && pathParts[1]) return contacts.deleteContact(req, userId);
    }

    // Digest Preferences
    if (pathParts[0] === "digest-preferences" && req.method === "GET") return contacts.handleDigestPreferences(req);
    if (pathParts[0] === "digest-preferences" && req.method === "PUT") return contacts.handleDigestPreferences(req);

    // Contact Interactions
    if (pathParts[0] === "contact-interactions" && req.method === "GET") return contacts.handleContactInteractions(req, userId);
    if (pathParts[0] === "contact-interactions" && req.method === "POST") return contacts.createContactInteraction(req, userId);

    // Contact Assignments (admin only)
    if (pathParts[0] === "contact-assignments") {
      if (req.method === "GET") return contacts.handleContactAssignments(req, userId);
      if (req.method === "POST") return contacts.createContactAssignment(req, userId);
      if (req.method === "DELETE" && pathParts[1]) return contacts.deleteContactAssignment(req, userId);
    }

    // Industries (top-level)
    if (pathParts[0] === "industries" && req.method === "GET") return contacts.handleIndustries(req);

    // Companies
    if (pathParts[0] === "companies") {
      if (req.method === "GET") return contacts.handleCompanies(req, userId);
      if (req.method === "POST") return contacts.createCompany(req, userId);
      if (req.method === "PUT" && pathParts[1]) return contacts.updateCompany(req, userId);
      if (req.method === "DELETE" && pathParts[1]) return contacts.deleteCompany(req, userId);
    }

    // Emails (templates, history — user-level)
    if (pathParts[0] === "emails") {
      if (req.method === "GET" && pathParts[1] === "templates") return emails.listTemplates(req, userId);
      if (req.method === "POST" && pathParts[1] === "templates") return emails.createTemplate(req, userId);
      if (req.method === "PUT" && pathParts[1] === "templates" && pathParts[2]) return emails.updateTemplate(req, pathParts[2], userId);
      if (req.method === "DELETE" && pathParts[1] === "templates" && pathParts[2]) return emails.deleteTemplate(req, pathParts[2], userId);
      if (req.method === "POST" && pathParts[1] === "send") return handleHermesEmailSend(req, token, userId);
      if (req.method === "GET" && pathParts[1] === "history") return handleGetEmailHistory(req, token, userId);
    }

    return error("Not found", 404);
  }

  // Legacy /auth/ paths
  if (resource === "auth") {
    if (segments[1] === "login" && req.method === "POST") return handleAuthLogin(req);
    if (segments[1] === "register" && req.method === "POST") return handleAuthRegister(req);
  }

  return error("Not found", 404);
}

const server = Bun.serve({ port: PORT, fetch: route });
console.log(`Hermes Server running on port ${PORT}`);
console.log(`   Resend API: ${RESEND_API_KEY ? "configured" : "NOT CONFIGURED"}`);
