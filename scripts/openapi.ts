import { writeFile } from 'node:fs/promises';
import { openapi } from '../src/api/openapi.js';
await writeFile('openapi.json', JSON.stringify(openapi, null, 2) + '\n');
process.stdout.write('openapi.json generated from API contracts.\n');
