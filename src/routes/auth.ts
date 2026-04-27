import { db } from "../db";
import * as jose from "jose";

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Content-Type": "application/json",
  };
}

const JWT_SECRET = process.env.JWT_SECRET || "super-secret-jwt-token-with-at-least-32-characters-long";

export async function verifyAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() }) };
  }
  const token = authHeader.slice(7);
  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jose.jwtVerify(token, secret);
    const userId = payload.sub as string;
    if (!userId) return { error: new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: corsHeaders() }) };
    return { userId };
  } catch {
    return { error: new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: corsHeaders() }) };
  }
}

export async function getUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jose.jwtVerify(token, secret);
    return payload.sub as string;
  } catch {
    return null;
  }
}
