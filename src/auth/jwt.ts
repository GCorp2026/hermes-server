import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'hermes-jwt-secret-change-me-in-production';
const JWT_EXPIRY = '7d';

export function signToken(payload: object): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
}
