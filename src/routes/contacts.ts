import { db } from "../db";
import { corsHeaders, getUserId } from "./auth";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

// GET /api/contacts
export async function handleContacts(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const [row] = await db`SELECT c.* FROM contacts c WHERE c.id = ${id} AND c.user_id = ${userId}`.execute();
    return json(row || null);
  }

  const rows = await db`SELECT * FROM contacts WHERE user_id = ${userId} ORDER BY created_at DESC`.execute();
  return json(rows);
}

// POST /api/contacts
export async function createContact(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { first_name, last_name, email, phone, company, title, notes } = await req.json();
  if (!first_name) return error("first_name is required");

  const [row] = await db`
    INSERT INTO contacts (user_id, first_name, last_name, email, phone, company, title, notes)
    VALUES (${userId}, ${first_name}, ${last_name || null}, ${email || null}, ${phone || null}, ${company || null}, ${title || null}, ${notes || null})
    RETURNING *
  `.execute();
  return json(row, 201);
}

// PUT /api/contacts/:id
export async function updateContact(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;
  const { first_name, last_name, email, phone, company, title, notes } = await req.json();

  const [row] = await db`
    UPDATE contacts SET
      first_name = COALESCE(${first_name}, first_name),
      last_name = COALESCE(${last_name}, last_name),
      email = COALESCE(${email}, email),
      phone = COALESCE(${phone}, phone),
      company = COALESCE(${company}, company),
      title = COALESCE(${title}, title),
      notes = COALESCE(${notes}, notes),
      updated_at = NOW()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING *
  `.execute();
  return json(row || null);
}

// DELETE /api/contacts/:id
export async function deleteContact(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;
  await db`DELETE FROM contacts WHERE id = ${id} AND user_id = ${userId}`.execute();
  return json({ success: true });
}

// GET /api/contact-interactions?contact_id=xxx
export async function handleContactInteractions(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const contactId = url.searchParams.get("contact_id");
  if (!contactId) return error("contact_id is required");

  // Verify contact ownership
  const [contact] = await db`SELECT id FROM contacts WHERE id = ${contactId} AND user_id = ${userId}`.execute();
  if (!contact) return error("Contact not found", 404);

  const rows = await db`SELECT * FROM contact_interactions WHERE contact_id = ${contactId} ORDER BY created_at DESC`.execute();
  return json(rows);
}

// POST /api/contact-interactions
export async function createContactInteraction(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { contact_id, type, content } = await req.json();
  if (!contact_id || !type || !content) return error("contact_id, type, and content are required");

  // Verify contact ownership
  const [contact] = await db`SELECT id FROM contacts WHERE id = ${contact_id} AND user_id = ${userId}`.execute();
  if (!contact) return error("Contact not found", 404);

  const [row] = await db`
    INSERT INTO contact_interactions (user_id, contact_id, type, content)
    VALUES (${userId}, ${contact_id}, ${type}, ${content})
    RETURNING *
  `.execute();
  return json(row, 201);
}

// GET /api/companies
export async function handleCompanies(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const rows = await db`SELECT * FROM companies WHERE user_id = ${userId} ORDER BY created_at DESC`.execute();
  return json(rows);
}

// POST /api/companies
export async function createCompany(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const { name, domain, industry, phone, notes } = await req.json();
  if (!name) return error("name is required");

  const [row] = await db`
    INSERT INTO companies (user_id, name, domain, industry, phone, notes)
    VALUES (${userId}, ${name}, ${domain || null}, ${industry || null}, ${phone || null}, ${notes || null})
    RETURNING *
  `.execute();
  return json(row, 201);
}

// PUT /api/companies/:id
export async function updateCompany(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;
  const { name, domain, industry, phone, notes } = await req.json();

  const [row] = await db`
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
}

// DELETE /api/companies/:id
export async function deleteCompany(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop()!;
  await db`DELETE FROM companies WHERE id = ${id} AND user_id = ${userId}`.execute();
  return json({ success: true });
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
