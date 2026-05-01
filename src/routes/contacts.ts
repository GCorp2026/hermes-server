import { db, withAuthContext } from "../db";
import { corsHeaders, getUserId } from "./auth";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

async function getUserRole(userId: string): Promise<'admin'|'super'|'employee'|'user'> {
  const [isAdmin] = await db`SELECT has_role(${userId}, 'admin') as v`.execute();
  if (isAdmin?.v) return 'admin';
  const [isSuper] = await db`SELECT has_role(${userId}, 'super') as v`.execute();
  if (isSuper?.v) return 'super';
  const [isEmployee] = await db`SELECT has_role(${userId}, 'employee') as v`.execute();
  if (isEmployee?.v) return 'employee';
  return 'user';
}

// GET /api/contacts
export async function handleContacts(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const role = await getUserRole(userId);
  const canViewAny = role === 'admin' || role === 'super';

  return withAuthContext(userId, async (sql) => {
    if (id) {
      const [row] = await sql`
        SELECT c.*, COALESCE(comp.name, c.company) as company
        FROM contacts c
        LEFT JOIN companies comp ON comp.id = c.company_id
        WHERE c.id = ${id} AND (c.user_id = ${userId} OR ${canViewAny} = true)
      `.execute();
      return json(row || null);
    }

    const rows = canViewAny
      ? await sql`
          SELECT c.*, COALESCE(comp.name, c.company) as company
          FROM contacts c
          LEFT JOIN companies comp ON comp.id = c.company_id
          ORDER BY c.created_at DESC
        `.execute()
      : await sql`
          SELECT c.*, COALESCE(comp.name, c.company) as company
          FROM contacts c
          LEFT JOIN companies comp ON comp.id = c.company_id
          WHERE c.user_id = ${userId}
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

  return withAuthContext(userId, async (sql) => {
    const [row] = await sql`
      INSERT INTO contacts (user_id, company_id, first_name, last_name, email, phone, company, job_title, deal_value, stage, notes)
      VALUES (${userId}, ${company_id || null}, ${first_name}, ${last_name || null}, ${email || null}, ${phone || null}, ${company || null}, ${job_title || title || null}, ${deal_value || 0}, ${stage || 'lead'}, ${notes || null})
      RETURNING *
    `.execute();
    return json(row, 201);
  });
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
  const canEditAny = role === 'admin' || role === 'super';

  return withAuthContext(userId, async (sql) => {
    const [row] = await sql`
      UPDATE contacts SET
        user_id = CASE WHEN ${canEditAny} = true THEN COALESCE(${user_id}, user_id) ELSE user_id END,
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
      WHERE id = ${id} AND (user_id = ${userId} OR ${canEditAny} = true)
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
  const canDeleteAny = role === 'admin' || role === 'super';

  return withAuthContext(userId, async (sql) => {
    await sql`DELETE FROM contacts WHERE id = ${id} AND (user_id = ${userId} OR ${canDeleteAny} = true)`.execute();
    return json({ success: true });
  });
}

// GET /api/contacts/users
export async function handleContactUsers(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);
  const role = await getUserRole(userId);
  if (role !== 'admin' && role !== 'super') return error("Forbidden", 403);

  const rows = await db`SELECT id, email, full_name FROM hermes_users ORDER BY full_name`.execute();
  return json(rows);
}

// GET /api/contact-interactions?contact_id=xxx
export async function handleContactInteractions(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const contactId = url.searchParams.get("contact_id");
  if (!contactId) return error("contact_id is required");

  return withAuthContext(userId, async (sql) => {
    const [contact] = await sql`SELECT id FROM contacts WHERE id = ${contactId} AND user_id = ${userId}`.execute();
    if (!contact) return error("Contact not found", 404);

    const rows = await sql`SELECT * FROM contact_interactions WHERE contact_id = ${contactId} ORDER BY created_at DESC`.execute();
    return json(rows);
  });
}

// POST /api/contact-interactions
export async function createContactInteraction(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { contact_id, type, content } = await req.json();
  if (!contact_id || !type || !content) return error("contact_id, type, and content are required");

  return withAuthContext(userId, async (sql) => {
    const [contact] = await sql`SELECT id FROM contacts WHERE id = ${contact_id} AND user_id = ${userId}`.execute();
    if (!contact) return error("Contact not found", 404);

    const [row] = await sql`
      INSERT INTO contact_interactions (user_id, contact_id, type, content)
      VALUES (${userId}, ${contact_id}, ${type}, ${content})
      RETURNING *
    `.execute();
    return json(row, 201);
  });
}

// GET /api/companies
export async function handleCompanies(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  return withAuthContext(userId, async (sql) => {
    const rows = await sql`SELECT * FROM companies WHERE user_id = ${userId} ORDER BY created_at DESC`.execute();
    return json(rows);
  });
}

// POST /api/companies
export async function createCompany(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { name, domain, industry, phone, notes } = await req.json();
  if (!name) return error("name is required");

  return withAuthContext(userId, async (sql) => {
    const [row] = await sql`
      INSERT INTO companies (user_id, name, domain, industry, phone, notes)
      VALUES (${userId}, ${name}, ${domain || null}, ${industry || null}, ${phone || null}, ${notes || null})
      RETURNING *
    `.execute();
    return json(row, 201);
  });
}

// PUT /api/companies/:id
export async function updateCompany(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;
  const { name, domain, industry, phone, notes } = await req.json();

  return withAuthContext(userId, async (sql) => {
    const [row] = await sql`
      UPDATE companies SET
        name = COALESCE(${name}, name),
        domain = COALESCE(${domain}, domain),
        industry = COALESCE(${industry}, industry),
        phone = COALESCE(${phone}, phone),
        notes = COALESCE(${notes}, notes),
        updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `.execute();
    return json(row || null);
  });
}

// DELETE /api/companies/:id
export async function deleteCompany(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;
  return withAuthContext(userId, async (sql) => {
    await sql`DELETE FROM companies WHERE id = ${id} AND user_id = ${userId}`.execute();
    return json({ success: true });
  });
}

// GET /api/digest-preferences
export async function handleDigestPreferences(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const [row] = await db`SELECT * FROM digest_preferences WHERE user_id = ${userId}`.execute();
  return json(row || null);
}

// PUT /api/digest-preferences
export async function updateDigestPreferences(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { opted_in, send_hour, timezone } = await req.json();

  const [row] = await db`
    INSERT INTO digest_preferences (user_id, opted_in, send_hour, timezone)
    VALUES (${userId}, ${opted_in !== undefined ? opted_in : true}, ${send_hour || 13}, ${timezone || 'UTC'})
    ON CONFLICT (user_id) DO UPDATE SET
      opted_in = COALESCE(${opted_in}, digest_preferences.opted_in),
      send_hour = COALESCE(${send_hour}, digest_preferences.send_hour),
      timezone = COALESCE(${timezone}, digest_preferences.timezone),
      updated_at = NOW()
    RETURNING *
  `.execute();
  return json(row);
}

// GET /api/industries
export async function handleIndustries(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const rows = await db`SELECT * FROM industries ORDER BY name`.execute();
  return json(rows);
}
