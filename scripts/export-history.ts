import 'dotenv/config';
import mongoose from 'mongoose';
import { open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
const [collectionArg, fromArg, toArg, pathArg] = process.argv.slice(2);
const collection = z
  .enum(['market_candles', 'market_volume_profiles', 'option_snapshots', 'option_aggregates'])
  .parse(collectionArg);
const from = z.coerce.number().int().positive().parse(fromArg),
  to = z.coerce.number().int().positive().parse(toArg);
if (to <= from || !pathArg)
  throw new Error('Usage: export-history <collection> <from-epoch-ms> <to-epoch-ms> <new-output.jsonl>');
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI required');
const path = resolve(pathArg),
  file = await open(path, 'wx', 0o600),
  hash = createHash('sha256');
const db = await mongoose
  .createConnection(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 2 })
  .asPromise();
let count = 0;
try {
  const timeField =
    collection === 'option_snapshots'
      ? 'sourceTs'
      : collection === 'market_volume_profiles'
        ? 'receivedAt'
        : 'start';
  const cursor = db
    .collection(collection)
    .find({ [timeField]: { $gte: from, $lt: to } })
    .project({ _id: 0, retentionAt: 0, retentionRetryAt: 0 })
    .sort({ [timeField]: 1, id: 1 })
    .batchSize(500);
  for await (const row of cursor) {
    const line = `${JSON.stringify(row)}\n`;
    hash.update(line);
    await file.write(line);
    count++;
  }
  await file.sync();
  await file.close();
  await writeFile(
    `${path}.manifest.json`,
    JSON.stringify(
      {
        version: 'market-archive:1',
        collection,
        from,
        to,
        count,
        sha256: hash.digest('hex'),
        units: {
          timestamps: 'UTC epoch milliseconds',
          prices: 'INR per unit',
          volume: 'provider native traded quantity; cumulative and interval fields remain distinct',
        },
        sourceRecordsDeleted: false,
        createdAt: Date.now(),
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(
    `Exported ${count} records and integrity manifest. MongoDB source records were not modified.\n`,
  );
} finally {
  await file.close().catch(() => {});
  await db.close();
}
