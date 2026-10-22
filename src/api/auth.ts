import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../config.js';
const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex'),
    key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [method, salt, hex] = encoded.split(':');
  if (method !== 'scrypt' || !salt || !hex || hex.length !== 128) return false;
  const expected = Buffer.from(hex, 'hex'),
    actual = (await scrypt(password, salt, 64)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function issueToken(c: Config): Promise<string> {
  return new SignJWT({ scope: 'research:owner' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('owner')
    .setIssuer('stockss')
    .setAudience('stockss-api')
    .setIssuedAt()
    .setExpirationTime(`${c.TOKEN_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(c.JWT_SECRET));
}
export async function verifyToken(token: string, c: Config): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(c.JWT_SECRET), {
      algorithms: ['HS256'],
      issuer: 'stockss',
      audience: 'stockss-api',
    });
    return payload.sub === 'owner' && payload.scope === 'research:owner';
  } catch {
    return false;
  }
}
