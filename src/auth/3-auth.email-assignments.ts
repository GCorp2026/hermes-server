import { db } from '../db';

function json(data: unknown, status = 200) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  };
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

// GET /api/auth/admin/email-assignments
export async function handleAdminListEmailAssignments(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const assignments = await db`SELECT id, user_id, email_address, domain, display_name, is_active, work_email, created_at FROM public.hermes_email_assignments ORDER BY created_at DESC LIMIT 100`.execute();
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
    
    // Insert into email_assignments (legacy table)
    await db`INSERT INTO public.hermes_email_assignments (user_id, email_address, domain, display_name, provider, work_email) VALUES (${user_id}::uuid, ${email_address}, ${domain || 'glinskyhq.ru'}, ${display_name || ''}, 'resend', ${email_address})`.execute();
    
    // Also upsert into hermes_work_emails (used by email tab dashboard)
    await db`
      INSERT INTO public.hermes_work_emails (user_id, work_email, display_name, is_primary)
      VALUES (${user_id}::uuid, ${email_address}, ${display_name || ''}, true)
      ON CONFLICT (user_id, work_email) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        updated_at = now()
    `.execute();
    
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
    
    // Get the email address before deleting
    const [assignment] = await db`SELECT user_id, email_address FROM public.hermes_email_assignments WHERE id = ${id}`.execute();
    
    await db`DELETE FROM public.hermes_email_assignments WHERE id = ${id}`.execute();
    
    // Also remove from hermes_work_emails
    if (assignment) {
      await db`DELETE FROM public.hermes_work_emails WHERE user_id = ${assignment.user_id}::uuid AND work_email = ${assignment.email_address}`.execute();
    }
    
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
