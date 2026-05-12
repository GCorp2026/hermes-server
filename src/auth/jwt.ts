import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'hermes-dev-secret-2024';
const JWT_EXPIRY = '7d';

export function signToken(payload: object & { password_version?: number }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
}
