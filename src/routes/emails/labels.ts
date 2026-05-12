import { withAuthContext } from "../../db";
import { corsHeaders, getUserId } from "../auth";
import { json, error } from "./core";

// GET /api/email-labels
export async function handleEmailLabels(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  return withAuthContext(userId, async (sql) => {
    const rows = await sql`SELECT * FROM email_labels WHERE user_id = ${userId} ORDER BY name`.execute();
    return json(rows);
  });
}

// POST /api/email-labels
export async function createEmailLabel(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  return withAuthContext(userId, async (sql) => {
    const { name, color } = await req.json();
    if (!name) return error("name is required");

    const [row] = await sql`INSERT INTO email_labels (user_id, name, color) VALUES (${userId}, ${name}, ${color || '#000000'}) RETURNING *`.execute();
    return json(row, 201);
  });
}

// DELETE /api/email-labels/:id
export async function deleteEmailLabel(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  return withAuthContext(userId, async (sql) => {
    const url = new URL(req.url);
    const id = url.pathname.split("/").pop()!;
    await sql`DELETE FROM email_labels WHERE id = ${id} AND user_id = ${userId}`.execute();
    return json({ success: true });
  });
}

// GET /api/email-label-assignments
export async function handleLabelAssignments(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  return withAuthContext(userId, async (sql) => {
    const rows = await sql`SELECT ela.* FROM public.hermes_email_label_assignments ela JOIN work_emails we ON ela.work_email_id = we.id WHERE we.user_id = ${userId}`.execute();
    return json(rows);
  });
}

// POST /api/email-label-assignments
export async function createLabelAssignment(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  return withAuthContext(userId, async (sql) => {
    const { email_history_id, label_id } = await req.json();
    if (!email_history_id || !label_id) return error("email_history_id and label_id required");

    const [assignment] = await sql`
      INSERT INTO public.hermes_email_label_assignments (email_history_id, label_id)
      SELECT ${email_history_id}, ${label_id}
      WHERE EXISTS (SELECT 1 FROM email_labels WHERE id = ${label_id} AND user_id = ${userId})
      RETURNING *
    `.execute();

    return json(assignment || { error: "Failed to create assignment" }, assignment ? 201 : 400);
  });
}

// DELETE /api/email-label-assignments?email_history_id=xxx&label_id=yyy
export async function deleteLabelAssignment(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const userId = await getUserId(req);
  if (!userId) return error("Unauthorized", 401);

  return withAuthContext(userId, async (sql) => {
    const url = new URL(req.url);
    const emailHistoryId = url.searchParams.get("email_history_id");
    const labelId = url.searchParams.get("label_id");

    await sql`DELETE FROM public.hermes_email_label_assignments WHERE email_history_id = ${emailHistoryId} AND label_id = ${labelId}`.execute();
    return json({ success: true });
  });
}
