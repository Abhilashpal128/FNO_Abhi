import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { MongoStore } from '../src/db/store.js';
import { retentionPolicy } from '../src/db/retention.js';
const path = process.argv[2];
if (!path) throw new Error('Usage: import-validation <metadata.json>');
const text = await readFile(path, 'utf8');
if (text.length > 2000000) throw new Error('Validation report too large');
const report = z
  .object({
    modelVersion: z.string().min(1),
    createdAt: z.number().positive(),
    outcomeDefinition: z.literal('option-target2-before-stop-v1'),
    datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
    unseenStart: z.number().positive(),
    unseenEnd: z.number().positive(),
    variants: z.record(z.string(), z.unknown()),
    validated: z.literal(false),
  })
  .passthrough()
  .parse(JSON.parse(text));
const c = loadConfig(),
  store = await MongoStore.connect(c.MONGODB_URI, c.SNAPSHOT_RETENTION_DAYS, retentionPolicy(c));
try {
  const id = createHash('sha256').update(text).digest('hex');
  await store.insertMany('validation_reports', [
    { id, createdAt: report.createdAt, modelVersion: report.modelVersion, validated: false, report },
  ]);
  await store.insertMany('model_versions', [
    {
      id: report.modelVersion,
      name: 'LightGBM option outcome research',
      version: report.modelVersion,
      createdAt: report.createdAt,
      validated: false,
      details: {
        validationReportId: id,
        calibrationValidated: false,
        walkForwardValidated: false,
        reviewRequired: true,
      },
    },
  ]);
  process.stdout.write(
    'Validation evidence imported; model remains unapproved and probability serving remains disabled.\n',
  );
} finally {
  await store.close();
}
