import { corsHeaders } from './routes/auth';
import { db } from './db';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

// POST /api/auth/login
async function handleAuthLogin(req: Request): Promise<Response> {
  try {
    const { email, password } = await req.json();
    if (!email || !password) return json({ error: 'email and password required' }, 400);
    
    const users = await db`SELECT id, email, password_hash, full_name FROM hermes_users WHERE email = ${email}`.execute();
    if (!users.length) return json({ error: 'Invalid credentials' }, 401);
    
    const user = users[0];
    const valid = await Bun.password.verify(password, user.password_hash);
    if (!valid) return json({ error: 'Invalid credentials' }, 401);
    
    const roles = await db`SELECT role FROM public.user_roles WHERE user_id = ${user.id}`.execute();
    const role = roles.find(r => r.role === 'admin' || r.role === 'super') ? 'admin' : (roles[0]?.role || 'user');
    
    const token = await new Promise((resolve, reject) => {
      require('jsonwebtoken', (err: Error, token: string) => {
        if (err) reject(err); else resolve(token);
      });
    });
    
    const JWT_SECRET = process.env.JWT_SECRET || 'hermes-dev-secret-2024';
    const signed = require('jsonwebtoken').sign(
      { userId: user.id, email: user.email, role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    return json({ token: signed, user: { id: user.id, email: user.email, full_name: user.full_name, role } });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// GET /api/auth/admin/users
async function handleAdminListUsers(req: Request): Promise<Response> {
  try {
    const users = await db`SELECT u.id, u.email, COALESCE(u.full_name, '') as full_name, COALESCE(ur.role, 'user') as role FROM auth.users u LEFT JOIN public.user_roles ur ON u.id = ur.user_id WHERE u.disabled = false ORDER BY u.created_at DESC LIMIT 50`.execute();
    return json({ users: users.map((u: any) => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role })) });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/admin/set-role
async function handleAdminSetRole(req: Request): Promise<Response> {
  try {
    const { user_id, role } = await req.json();
    if (!user_id || !role) return json({ error: 'user_id and role required' }, 400);
    await db`INSERT INTO public.user_roles (user_id, role, created_at, updated_at) VALUES (${user_id}::uuid, ${role}::public.app_role, NOW(), NOW()) ON CONFLICT (user_id) DO UPDATE SET role = ${role}::public.app_role, updated_at = NOW()`.execute();
    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
