import { db } from '../db';

function json(data: unknown, status = 200) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  };
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

// GET /api/auth/admin/users — list all users
export async function handleAdminListUsers(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const users = await db`SELECT u.id, u.email, COALESCE(u.full_name, '') as full_name, COALESCE(ur.role, 'customer') as role FROM public.hermes_users u LEFT JOIN public.hermes_user_roles ur ON u.id = ur.user_id ORDER BY u.created_at DESC LIMIT 50`.execute();
    return json({ users: users.map(u => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role })) });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/admin/set-role
const VALID_ROLES = ['admin', 'super', 'employee', 'customer', 'manager'];
export async function handleAdminSetRole(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const { user_id, role } = await req.json();
    if (!user_id || !role) return json({ error: 'user_id and role required' }, 400);
    if (!VALID_ROLES.includes(role)) return json({ error: 'Invalid role' }, 400);
    // Delete existing role then insert new one (user_roles has no unique constraint on user_id)
    await db`DELETE FROM public.hermes_user_roles WHERE user_id = ${user_id}`.execute();
    await db`INSERT INTO public.hermes_user_roles (user_id, role) VALUES (${user_id}, ${role})`.execute();
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
    await db`DELETE FROM public.hermes_user_roles WHERE user_id = ${targetId}`.execute();
    await db`DELETE FROM public.hermes_users WHERE id = ${targetId}`.execute();
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
    for (const id of toDelete) {
      await db`DELETE FROM public.hermes_user_roles WHERE user_id = ${id}`.execute();
      await db`DELETE FROM public.hermes_users WHERE id = ${id}`.execute();
    }
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
    if (!VALID_ROLES.includes(role)) return json({ error: 'Invalid role' }, 400);
    for (const id of user_ids) {
      await db`DELETE FROM public.hermes_user_roles WHERE user_id = ${id}`.execute();
      await db`INSERT INTO public.hermes_user_roles (user_id, role) VALUES (${id}, ${role})`.execute();
    }
    return json({ success: true, updated: user_ids.length });
  } catch (e: any) {
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
      await db`UPDATE public.hermes_users SET full_name = ${full_name} WHERE id = ${targetId}`.execute();
    }
    if (email !== undefined) {
      await db`UPDATE public.hermes_users SET email = ${email} WHERE id = ${targetId}`.execute();
    }
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/admin/users/:id/password — reset user password + invalidate old tokens
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

    const [target] = await db`SELECT id FROM public.hermes_users WHERE id = ${targetId}`.execute();
    if (!target) return json({ error: 'User not found' }, 404);

    const hash = await Bun.password.hash(password);
    // Increment password_version to invalidate old tokens
    await db`UPDATE public.hermes_users SET password_hash = ${hash}, password_version = password_version + 1 WHERE id = ${targetId}`.execute();
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
