import { readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/api/auth.js';
let content: string;
try {
  await access('.env');
  content = await readFile('.env', 'utf8');
} catch {
  content = await readFile('.env.example', 'utf8');
}
// Add new settings without replacing existing values or credentials.
const example = await readFile('.env.example', 'utf8');
for (const line of example.split(/\r?\n/)) {
  const key = line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1];
  if (key && !new RegExp(`^${key}=`, 'm').test(content)) content += `\n${line}\n`;
}
const setMissing = (key: string, value: string) => {
  const pattern = new RegExp(`^${key}=(.*)$`, 'm');
  const found = content.match(pattern);
  if (found?.[1]?.trim()) return;
  if (found) content = content.replace(pattern, `${key}=${value}`);
  else content += `\n${key}=${value}\n`;
};
const password = randomBytes(24).toString('base64url');
if (!/^APP_PASSWORD_HASH=\S+/m.test(content)) {
  setMissing('APP_PASSWORD_HASH', await hashPassword(password));
  setMissing('APP_INITIAL_PASSWORD', password);
}
setMissing('JWT_SECRET', randomBytes(48).toString('base64url'));
await writeFile('.env', content, { mode: 0o600 });
process.stdout.write(
  'Local .env prepared. Login password is APP_INITIAL_PASSWORD in .env; no secret was printed. Existing configured values were preserved.\n',
);
