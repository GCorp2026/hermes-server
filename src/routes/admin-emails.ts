import { db, withAuthContext } from "../db";
import { corsHeaders, getUserId } from "./auth";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

async function isAdminUser(userId: string) {
  const [isAdmin] = await db`SELECT has_role(${userId}, 'admin') as v`.execute();
  const [isSuper] = await db`SELECT has_role(${userId}, 'super') as v`.execute();
  return Boolean(isAdmin?.v || isSuper?.v);
}

// GET /api/admin/emails
// Admin-only: list all emails with filters and sorting
export async function handleAdminEmails(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);
  if (!await isAdminUser(userId)) return error("Forbidden", 403);

  const url = new URL(req.url);
  const page = Math.max(parseInt(url.searchParams.get("page") || "0"), 0);
  const pageSize = Math.min(Math.max(parseInt(url.searchParams.get("pageSize") || "50"), 1), 100);
  const userFilter = url.searchParams.get("userId");
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  const sortBy = url.searchParams.get("sortBy") || "created_at";
  const sortDir = url.searchParams.get("sortDir") || "desc";
  const includeDeleted = url.searchParams.get("includeDeleted") === "true";

  return withAuthContext(userId, async (sql) => {
    const filters = sql`
      WHERE 1=1
        ${includeDeleted ? sql`` : sql`AND e.deleted_at IS NULL`}
        ${userFilter ? sql`AND e.user_id = ${userFilter}` : sql``}
        ${dateFrom ? sql`AND e.created_at >= ${dateFrom}` : sql``}
        ${dateTo ? sql`AND e.created_at <= ${dateTo}` : sql``}
    `;

    const sortCol = sortBy === "from_address" ? "e.from_address" : sortBy === "user_id" ? "e.user_id" : "e.created_at";
    const orderDir = sortDir === "asc" ? "asc" : "desc";
    const offset = page * pageSize;

    const [countRow] = await sql`SELECT count(*)::int as total FROM emails e ${filters}`.execute();
    const rows = await sql`
      SELECT e.*, u.email as user_email, u.full_name as user_name
      FROM emails e
      LEFT JOIN hermes_users u ON u.id = e.user_id
      ${filters}
      ORDER BY ${sql.unsafe(sortCol)} ${sql.unsafe(orderDir)}
      LIMIT ${pageSize} OFFSET ${offset}
    `.execute();

    return json({ emails: rows, total: countRow?.total || 0, page, pageSize });
  });
}

// POST /api/admin/emails/search
// AI-powered email search using MiniMax
export async function handleAdminEmailSearch(req: Request, authenticatedUserId?: string) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  const userId = authenticatedUserId || await getUserId(req);
  if (!userId) return error("Unauthorized", 401);
  if (!await isAdminUser(userId)) return error("Forbidden", 403);

  const { query, model, userId: filterUserId, limit = 20 } = await req.json();
  if (!query || typeof query !== "string") return error("query is required");

  const aiModel = model || "MiniMax-M2.7";
  const searchLimit = Math.min(Math.max(parseInt(String(limit)), 1), 50);

  const candidates = await db`
    SELECT e.id, e.subject, e.body, e.from_address, e.to_address, e.user_id, e.created_at, u.email as user_email
    FROM emails e
    LEFT JOIN hermes_users u ON u.id = e.user_id
    WHERE e.deleted_at IS NULL
      AND (e.subject IS NOT NULL OR e.body IS NOT NULL)
      ${filterUserId ? db`AND e.user_id = ${filterUserId}` : db``}
    ORDER BY e.created_at DESC
    LIMIT 500
  `.execute();

  if (candidates.length === 0) return json({ results: [], query });

  const emailList = candidates.map((e: any, i: number) =>
    `${i + 1}. [${e.subject || "(no subject)"}] from: ${e.from_address} | preview: ${(e.body || "").slice(0, 200)}`
  ).join("\n");

  const systemPrompt = "You are an expert email search assistant. Given a user query and a list of emails, return the indices (1-based) of emails that match the query. Consider subject keywords, sender, and email content. Return ONLY a JSON array of matching indices like [1,3,5] with no other text. If none match, return [].";
  const userPrompt = `Query: ${query}\n\nEmails:\n${emailList}\n\nReturn JSON array of matching email indices:`;

  try {
    const aiResp = await fetch("https://api.minimax.io/anthropic/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MINIMAX_API_KEY || ""}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: aiModel,
        max_tokens: 1024,
        messages: [{ role: "user", content: `${systemPrompt}\n\n${userPrompt}` }],
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      return json({ error: `AI search failed: ${aiResp.status}`, detail: errText.slice(0, 200) }, 500);
    }

    const aiData: any = await aiResp.json();
    const textBlock = aiData?.content?.find((b: any) => b.type === "text");
    let indices: number[] = [];
    try {
      const raw = textBlock?.text || "[]";
      indices = JSON.parse(raw.replace(/[^0-9,\[\]]/g, ""));
    } catch {}

    const results = indices
      .filter((idx: number) => idx >= 1 && idx <= candidates.length)
      .slice(0, searchLimit)
      .map((idx: number) => candidates[idx - 1]);

    return json({ results, query, model: aiModel, total: results.length });
  } catch (e: any) {
    return json({ error: "AI search error", detail: e.message }, 500);
  }
}
