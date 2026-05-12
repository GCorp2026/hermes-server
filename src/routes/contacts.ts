import { db, withAuthContext } from "../db";
import { corsHeaders, getUserId } from "./auth";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

async function getUserRole(userId: string): Promise<'admin'|'super'|'manager'|'employee'|'customer'|'user'> {
  const [isAdmin] = await db`SELECT has_role(${userId}, 'admin') as v`.execute();
  if (isAdmin?.v) return 'admin';
  const [isSuper] = await db`SELECT has_role(${userId}, 'super') as v`.execute();
  if (isSuper?.v) return 'super';
  const [isManager] = await db`SELECT has_role(${userId}, 'manager') as v`.execute();
  if (isManager?.v) return 'manager';
  const [isEmployee] = await db`SELECT has_role(${userId}, 'employee') as v`.execute();
  if (isEmployee?.v) return 'employee';
  const [isCustomer] = await db`SELECT has_role(${userId}, 'customer') as v`.execute();
  if (isCustomer?.v) return 'customer';
  return 'user';
}

/** Check if user is admin or super */
function isAdmin(userId: string, role: string): boolean {
  return role === 'admin' || role === 'super';
}

/** Check if user can see all companies/contacts (admin, super, employee, manager) */
function canSeeAll(userId: string, role: string): boolean {
  return role === 'admin' || role === 'super' || role === 'employee' || role === 'manager';
}

// GET /api/contacts
export async function handleContacts(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const role = await getUserRole(userId);
  const userIsAdmin = isAdmin(userId, role);

  return withAuthContext(userId, async (sql) => {
    if (id) {
      const [row] = await sql`
        SELECT c.*, COALESCE(comp.name, c.company) as company
        FROM public.hermes_contacts c
        LEFT JOIN public.hermes_companies comp ON comp.id = c.company_id
        WHERE c.id = ${id}
        AND (${userIsAdmin} = true OR EXISTS(
          SELECT 1 FROM public.hermes_contact_assignments ca
          WHERE ca.contact_id = c.id AND ca.assigned_to = ${userId}
        ))
      `.execute();
      return json(row || null);
    }

    const rows = userIsAdmin
      ? await sql`
          SELECT c.*, COALESCE(comp.name, c.company) as company
          FROM public.hermes_contacts c
          LEFT JOIN public.hermes_companies comp ON comp.id = c.company_id
          ORDER BY c.created_at DESC
        `.execute()
      : await sql`
          SELECT c.*, COALESCE(comp.name, c.company) as company
          FROM public.hermes_contacts c
          LEFT JOIN public.hermes_companies comp ON comp.id = c.company_id
          INNER JOIN public.hermes_contact_assignments ca ON ca.contact_id = c.id AND ca.assigned_to = ${userId}
          ORDER BY c.created_at DESC
        `.execute();
    return json(rows);
  });
}

// POST /api/contacts
export async function createContact(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { first_name, last_name, email, phone, company, job_title, title, deal_value, stage, notes, company_id } = await req.json();
  if (!first_name) return error("first_name is required");

  const [row] = await db.begin(async (sql) => {
    const [contact] = await sql`
      INSERT INTO public.hermes_contacts (user_id, company_id, first_name, last_name, email, phone, company, job_title, deal_value, stage, notes)
      VALUES (${userId}, ${company_id || null}, ${first_name}, ${last_name || null}, ${email || null}, ${phone || null}, ${company || null}, ${job_title || title || null}, ${deal_value || 0}, ${stage || 'lead'}, ${notes || null})
      RETURNING *
    `.execute();

    await sql`
      INSERT INTO public.hermes_contact_assignments (contact_id, assigned_to, assigned_by, assignment_type)
      VALUES (${contact.id}, ${userId}, ${userId}, 'creator')
      ON CONFLICT (contact_id, assigned_to) DO NOTHING
    `.execute();

    return contact;
  });

  return json(row, 201);
}

// PUT /api/contacts/:id
export async function updateContact(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;
  const { first_name, last_name, email, phone, company, job_title, title, deal_value, stage, notes, company_id, user_id } = await req.json();
  const role = await getUserRole(userId);
  const userIsAdmin = isAdmin(userId, role);

  return withAuthContext(userId, async (sql) => {
    const [row] = await sql`
      UPDATE public.hermes_contacts SET
        user_id = CASE WHEN ${userIsAdmin} = true THEN COALESCE(${user_id}, user_id) ELSE user_id END,
        company_id = COALESCE(${company_id}, company_id),
        first_name = COALESCE(${first_name}, first_name),
        last_name = COALESCE(${last_name}, last_name),
        email = COALESCE(${email}, email),
        phone = COALESCE(${phone}, phone),
        company = COALESCE(${company}, company),
        job_title = COALESCE(${job_title || title}, job_title),
        deal_value = COALESCE(${deal_value}, deal_value),
        stage = COALESCE(${stage}, stage),
        notes = COALESCE(${notes}, notes),
        updated_at = NOW()
      WHERE id = ${id}
      AND (${userIsAdmin} = true OR EXISTS(
        SELECT 1 FROM public.hermes_contact_assignments ca
        WHERE ca.contact_id = ${id} AND ca.assigned_to = ${userId}
      ))
      RETURNING *
    `.execute();
    return json(row || null);
  });
}

// DELETE /api/contacts/:id
export async function deleteContact(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;
  const role = await getUserRole(userId);
  const userIsAdmin = isAdmin(userId, role);

  return withAuthContext(userId, async (sql) => {
    await sql`DELETE FROM public.hermes_contacts
      WHERE id = ${id}
      AND (${userIsAdmin} = true OR EXISTS(
        SELECT 1 FROM public.hermes_contact_assignments ca
        WHERE ca.contact_id = ${id} AND ca.assigned_to = ${userId}
      ))
    `.execute();
    return json({ success: true });
  });
}

// GET /api/contacts/users
export async function handleContactUsers(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);
  const role = await getUserRole(userId);
  if (!isAdmin(userId, role)) return error("Forbidden", 403);

  const rows = await db`SELECT id, email, full_name FROM public.hermes_users ORDER BY full_name`.execute();
  return json(rows);
}

// GET /api/contact-interactions?contact_id=xxx&limit=...
export async function handleContactInteractions(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const contactId = url.searchParams.get("contact_id");
  const limitParam = url.searchParams.get("limit");

  return withAuthContext(userId, async (sql) => {
    const limit = limitParam ? parseInt(limitParam) : 100;
    const role = await getUserRole(userId);
    const userIsAdmin = isAdmin(userId, role);

    if (contactId) {
      const hasAccess = userIsAdmin || await sql`
        SELECT 1 FROM public.hermes_contact_assignments
        WHERE contact_id = ${contactId} AND assigned_to = ${userId}
      `.execute().then(r => r.length > 0);
      if (!hasAccess) return error("Contact not found", 404);

      const rows = await sql`
        SELECT * FROM public.hermes_contact_interactions
        WHERE contact_id = ${contactId}
        ORDER BY created_at DESC LIMIT ${limit}
      `.execute();
      return json(rows);
    } else {
      const rows = userIsAdmin
        ? await sql`SELECT * FROM public.hermes_contact_interactions ORDER BY created_at DESC LIMIT ${limit}`.execute()
        : await sql`
            SELECT ci.* FROM public.hermes_contact_interactions ci
            INNER JOIN public.hermes_contact_assignments ca ON ca.contact_id = ci.contact_id AND ca.assigned_to = ${userId}
            ORDER BY ci.created_at DESC LIMIT ${limit}
          `.execute();
      return json(rows);
    }
  });
}

// POST /api/contact-interactions
export async function createContactInteraction(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { contact_id, type, content } = await req.json();
  if (!contact_id || !type || !content) return error("contact_id, type, and content are required");

  const role = await getUserRole(userId);
  const userIsAdmin = isAdmin(userId, role);
  const hasAccess = userIsAdmin || await db`
    SELECT 1 FROM public.hermes_contact_assignments
    WHERE contact_id = ${contact_id} AND assigned_to = ${userId}
  `.execute().then(r => r.length > 0);

  if (!hasAccess) return error("Contact not found", 404);

  const [row] = await db`
    INSERT INTO public.hermes_contact_interactions (user_id, contact_id, type, content)
    VALUES (${userId}, ${contact_id}, ${type}, ${content})
    RETURNING *
  `.execute();
  return json(row, 201);
}

// GET /api/companies
export async function handleCompanies(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const role = await getUserRole(userId);
  const userCanSeeAll = canSeeAll(userId, role);

  return withAuthContext(userId, async (sql) => {
    // Admin/super/employee/manager see all companies
    // Customer/user see only companies where they have assigned contacts
    const rows = userCanSeeAll
      ? await sql`SELECT * FROM public.hermes_companies ORDER BY created_at DESC`.execute()
      : await sql`
          SELECT DISTINCT comp.* FROM public.hermes_companies comp
          INNER JOIN public.hermes_contacts c ON c.company_id = comp.id
          INNER JOIN public.hermes_contact_assignments ca ON ca.contact_id = c.id AND ca.assigned_to = ${userId}
          ORDER BY comp.created_at DESC
        `.execute();
    return json(rows);
  });
}

// POST /api/companies — anyone can create
export async function createCompany(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { name, domain, industry, phone, notes } = await req.json();
  if (!name) return error("name is required");

  return withAuthContext(userId, async (sql) => {
    const [row] = await sql`
      INSERT INTO public.hermes_companies (created_by, name, domain, industry, phone, notes)
      VALUES (${userId}, ${name}, ${domain || null}, ${industry || null}, ${phone || null}, ${notes || null})
      RETURNING *
    `.execute();
    return json(row, 201);
  });
}

// PUT /api/companies/:id — anyone can edit
export async function updateCompany(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;
  const { name, domain, industry, phone, notes } = await req.json();

  return withAuthContext(userId, async (sql) => {
    const [row] = await sql`
      UPDATE public.hermes_companies SET
        name = COALESCE(${name}, name),
        domain = COALESCE(${domain}, domain),
        industry = COALESCE(${industry}, industry),
        phone = COALESCE(${phone}, phone),
        notes = COALESCE(${notes}, notes),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `.execute();
    return json(row || null);
  });
}

// DELETE /api/companies/:id — anyone can delete
export async function deleteCompany(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;

  return withAuthContext(userId, async (sql) => {
    await sql`DELETE FROM public.hermes_companies WHERE id = ${id}`.execute();
    return json({ success: true });
  });
}

// GET /api/digest-preferences
export async function handleDigestPreferences(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const [row] = await db`SELECT * FROM public.hermes_digest_preferences WHERE user_id = ${userId}`.execute();
  return json(row || null);
}

// PUT /api/digest-preferences
export async function updateDigestPreferences(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { opted_in, send_hour, timezone } = await req.json();

  const [row] = await db`
    INSERT INTO public.hermes_digest_preferences (user_id, opted_in, send_hour, timezone)
    VALUES (${userId}, ${opted_in !== undefined ? opted_in : true}, ${send_hour || 13}, ${timezone || 'UTC'})
    ON CONFLICT (user_id) DO UPDATE SET
      opted_in = COALESCE(${opted_in}, hermes_digest_preferences.opted_in),
      send_hour = COALESCE(${send_hour}, hermes_digest_preferences.send_hour),
      timezone = COALESCE(${timezone}, hermes_digest_preferences.timezone),
      updated_at = NOW()
    RETURNING *
  `.execute();
  return json(row);
}

// GET /api/industries
export async function handleIndustries(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const rows = await db`SELECT * FROM public.hermes_industries ORDER BY name`.execute();
  return json(rows);
}

// ── Contact Assignments (admin/super only) ─────────────────────────────────

// GET /api/contact-assignments
export async function handleContactAssignments(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const role = await getUserRole(userId);
  if (!isAdmin(userId, role)) return error("Forbidden", 403);

  const rows = await db`
    SELECT ca.*,
           c.first_name, c.last_name, c.email as contact_email,
           u.email as assigned_to_email, u.full_name as assigned_to_name
    FROM public.hermes_contact_assignments ca
    LEFT JOIN public.hermes_contacts c ON c.id = ca.contact_id
    LEFT JOIN public.hermes_users u ON u.id = ca.assigned_to
    ORDER BY ca.created_at DESC
  `.execute();
  return json(rows);
}

// POST /api/contact-assignments
export async function createContactAssignment(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const role = await getUserRole(userId);
  if (!isAdmin(userId, role)) return error("Forbidden", 403);

  const { contact_id, assigned_to, assignment_type, notes } = await req.json();
  if (!contact_id || !assigned_to) return error("contact_id and assigned_to required", 400);

  const [row] = await db`
    INSERT INTO public.hermes_contact_assignments (contact_id, assigned_to, assigned_by, assignment_type, notes)
    VALUES (${contact_id}, ${assigned_to}, ${userId}, ${assignment_type || 'primary'}, ${notes || null})
    ON CONFLICT (contact_id, assigned_to) DO UPDATE SET
      assignment_type = COALESCE(${assignment_type}, hermes_contact_assignments.assignment_type),
      notes = COALESCE(${notes}, hermes_contact_assignments.notes),
      updated_at = NOW()
    RETURNING *
  `.execute();
  return json(row, 201);
}

// DELETE /api/contact-assignments/:id
export async function deleteContactAssignment(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const role = await getUserRole(userId);
  if (!isAdmin(userId, role)) return error("Forbidden", 403);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;

  await db`DELETE FROM public.hermes_contact_assignments WHERE id = ${id}`.execute();
  return json({ success: true });
}
