import { db } from '../db';
import { signToken, verifyToken } from './jwt';

function json(data: unknown, status = 200) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  };
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

// POST /api/auth/register
export async function handleAuthRegister(req: Request): Promise<Response> {
  try {
    const { email, password, full_name } = await req.json();
    if (!email || !password) return error('email and password required', 400);
    const hash = await Bun.password.hash(password);
    const [user] = await db`INSERT INTO public.hermes_users (email, password_hash, full_name, password_version) VALUES (${email}, ${hash}, ${full_name || ''}, 1) RETURNING id, email, full_name, password_version`.execute();
    await db`INSERT INTO public.hermes_user_roles (user_id, role) VALUES (${user.id}, 'customer')`.execute();
    const token = signToken({ userId: user.id, email: user.email, role: 'customer', password_version: user.password_version });
    return json({ token, user: { id: user.id, email: user.email, full_name: user.full_name, role: 'customer', password_version: user.password_version } });
  } catch (e: any) {
    if (e.message?.includes('duplicate') || e.message?.includes('unique')) return error('Email already registered', 400);
    return error(e.message, 500);
  }
}

// POST /api/auth/login
export async function handleAuthLogin(req: Request): Promise<Response> {
  try {
    const { email, password } = await req.json();
    if (!email || !password) return error('email and password required', 400);
    const users = await db`SELECT id, email, password_hash, full_name, password_version FROM public.hermes_users WHERE email = ${email}`.execute();
    if (!users.length) return error('Invalid credentials', 401);
    const valid = await Bun.password.verify(password, users[0].password_hash);
    if (!valid) return error('Invalid credentials', 401);
    const roles = await db`SELECT role FROM public.hermes_user_roles WHERE user_id = ${users[0].id}`.execute();
    const role = roles.find((r: any) => r.role === 'admin' || r.role === 'super')?.role || roles[0]?.role || 'customer';
    const token = signToken({ userId: users[0].id, email: users[0].email, role, password_version: users[0].password_version });
    return json({ token, user: { id: users[0].id, email: users[0].email, full_name: users[0].full_name, role, password_version: users[0].password_version } });
  } catch (err) {
    console.error('Login error:', err);
    return error('Internal server error', 500);
  }
}

// GET /api/auth/user-roles/:userId
export async function handleGetUserRoles(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const userId = url.pathname.split('/').pop();
    if (!userId) return error('user_id required');
    const roles = await db`SELECT role FROM public.hermes_user_roles WHERE user_id = ${userId}`.execute();
    return json({ roles: roles.map((r: any) => r.role) });
  } catch (e: any) {
    return error(e.message);
  }
}

// GET /api/auth/me
export async function handleAuthMe(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const [user] = await db`SELECT id, email, full_name, password_version FROM public.hermes_users WHERE id = ${userId}`.execute();
    if (!user) return error('User not found', 404);
    const roles = await db`SELECT role FROM public.hermes_user_roles WHERE user_id = ${userId}`.execute();
    return json({ user: { ...user, roles: roles.map((r: any) => r.role) } });
  } catch (e: any) {
    return error(e.message, 500);
  }
}

// POST /api/auth/validate-token
export async function handleValidateToken(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const [user] = await db`SELECT password_version FROM public.hermes_users WHERE id = ${userId}`.execute();
    if (!user) return json({ valid: false, reason: 'user_not_found' }, 404);
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'hermes-dev-secret-2024';
    let tokenPwVersion = 1;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      tokenPwVersion = decoded.password_version ?? 1;
    } catch {}
    const valid = user.password_version === tokenPwVersion;
    return json({ valid, current_password_version: user.password_version, token_password_version: tokenPwVersion });
  } catch (e: any) {
    return error(e.message, 500);
  }
}

// POST /api/auth/promote-to-admin
export async function handlePromoteToAdmin(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const { email } = await req.json();
    if (!email) return error('email required');
    const users = await db`SELECT id FROM public.hermes_users WHERE email = ${email}`.execute();
    if (!users.length) return error('User not found', 404);
    const targetId = users[0].id;
    if (targetId === userId) return error('Cannot promote yourself', 400);
    await db`INSERT INTO public.hermes_user_roles (user_id, role) VALUES (${targetId}, 'admin')`.execute();
    return json({ success: true });
  } catch (e: any) {
    return error(e.message, 500);
  }
}

export { json, error };
