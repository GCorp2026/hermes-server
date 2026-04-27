import { db } from '../db';
import { signToken, verifyToken } from './jwt';
import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 10;

function json(data: unknown, status = 200) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  };
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

export async function handleGetUserRoles(req: Request): Promise<Response> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return error('Missing authorization', 401);
  const token = authHeader.slice(7);
  try {
    const decoded = verifyToken(token);
    const userId = decoded.userId as string;
    // Get all roles for this user
    const roles = await db`SELECT role FROM public.user_roles WHERE user_id = ${userId}`.execute();
    return json({ roles: roles.map(r => r.role) });
  } catch {
    return error('Invalid token', 401);
  }
}

// GET /api/auth/me
export async function handleAuthMe(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' },
    });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return error('Missing or invalid authorization header', 401);

  const token = authHeader.slice(7);
  try {
    const decoded = verifyToken(token);
    const userId = decoded.userId as string;
    if (!userId) return error('Invalid token payload', 401);

    const [row] = await db`SELECT id, email, full_name, created_at FROM public.hermes_users WHERE id = ${userId}`.execute();
    if (!row) return error('User not found', 404);

    const [roleRow] = await db`SELECT role FROM public.user_roles WHERE user_id = ${userId}`.execute();

    return json({ user: { ...row, role: roleRow?.role || 'employee' } });
  } catch {
    return error('Invalid or expired token', 401);
  }
}

// POST /api/auth/register
export async function handleAuthRegister(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' },
    });
  }

  try {
    const { email, password, full_name } = await req.json();
    if (!email || !password || !full_name) return error('email, password, and full_name are required', 400);

    // Check if user already exists
    const [existing] = await db`SELECT id FROM public.hermes_users WHERE email = ${email}`.execute();
    if (existing) return error('User already exists', 409);

    // Hash password
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Insert into hermes_users
    const [user] = await db`
      INSERT INTO public.hermes_users (email, password_hash, full_name, created_at, updated_at)
      VALUES (${email}, ${password_hash}, ${full_name}, NOW(), NOW())
      RETURNING id, email, full_name, created_at
    `.execute();

    const userId = user.id;

    // Insert 'employee' role
    await db`
      INSERT INTO public.user_roles (user_id, role, created_at)
      VALUES (${userId}, 'employee', NOW())
    `.execute();

    // Insert into employees table
    await db`
      INSERT INTO public.employees (user_id, created_at, updated_at)
      VALUES (${userId}, NOW(), NOW())
    `.execute();

    // Generate JWT
    const token = signToken({ userId, email, role: 'employee' });

    return json({ token, user: { id: user.id, email: user.email, full_name: user.full_name, role: 'employee' } }, 201);
  } catch (err) {
    console.error('Register error:', err);
    return error('Internal server error', 500);
  }
}

// POST /api/auth/promote-to-admin
// Body: { email: string } or { all: true }
export async function handlePromoteToAdmin(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' },
    });
  }

  // Verify caller is admin
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return error('Missing authorization', 401);
  const token = authHeader.slice(7);
  let callerId: string;
  try {
    const decoded = verifyToken(token);
    callerId = decoded.userId as string;
  } catch {
    return error('Invalid token', 401);
  }

  // Check caller is admin
  const [callerRole] = await db`SELECT role FROM public.user_roles WHERE user_id = ${callerId}`.execute();
  if (callerRole?.role !== 'admin') return error('Admin only', 403);

  try {
    const body = await req.json();

    if (body.all === true) {
      // Promote ALL users to admin (upsert)
      await db`INSERT INTO public.user_roles (user_id, role, created_at)
               SELECT id, 'admin', NOW() FROM public.hermes_users
               ON CONFLICT (user_id, role) DO NOTHING`.execute();
      const [allUsers] = await db`SELECT id FROM public.hermes_users`.execute();
      return json({ success: true, promoted: allUsers.length });
    }

    const { email } = body;
    if (!email) return error('email required', 400);

    const [user] = await db`SELECT id FROM public.hermes_users WHERE email = ${email}`.execute();
    if (!user) return error('User not found', 404);

    await db`INSERT INTO public.user_roles (user_id, role, created_at)
             VALUES (${user.id}, 'admin', NOW())
             ON CONFLICT (user_id, role) DO NOTHING`.execute();

    return json({ success: true, user_id: user.id });
  } catch (err) {
    console.error('Promote error:', err);
    return error('Internal server error', 500);
  }
}

// POST /api/auth/login
export async function handleAuthLogin(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' },
    });
  }

  try {
    const { email, password } = await req.json();
    if (!email || !password) return error('email and password are required', 400);

    // Look up user
    const [row] = await db`
      SELECT id, email, password_hash, full_name
      FROM public.hermes_users
      WHERE email = ${email}
    `.execute();

    if (!row) return error('Invalid credentials', 401);

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) return error('Invalid credentials', 401);

    // Get role
    const [roleRow] = await db`SELECT role FROM public.user_roles WHERE user_id = ${row.id}`.execute();
    const role = roleRow?.role || 'employee';

    const token = signToken({ userId: row.id, email: row.email, role });

    return json({ token, user: { id: row.id, email: row.email, full_name: row.full_name, role } });
  } catch (err) {
    console.error('Login error:', err);
    return error('Internal server error', 500);
  }
}

// GET /api/auth/admin/users — list all users (admin only, from Hermes Postgres)
async function handleAdminListUsers(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const users = await db`SELECT u.id, u.email, COALESCE(u.full_name, '') as full_name, COALESCE(ur.role, 'user') as role FROM auth.users u LEFT JOIN public.user_roles ur ON u.id = ur.user_id WHERE u.disabled = false ORDER BY u.created_at DESC LIMIT 50`.execute();
    return json({ users: users.map(u => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role })) });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/admin/set-role — set a user's role (admin only)
async function handleAdminSetRole(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const body = await req.json();
    const { user_id, role } = body;
    if (!user_id || !role) return json({ error: 'user_id and role required' }, 400);
    
    await db`INSERT INTO public.user_roles (user_id, role, created_at, updated_at) VALUES (${user_id}::uuid, ${role}::public.app_role, NOW(), NOW()) ON CONFLICT (user_id) DO UPDATE SET role = ${role}::public.app_role, updated_at = NOW()`.execute();
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
