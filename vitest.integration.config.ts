import { defineConfig } from "vitest/config";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
// Keep temporary replica-set files on the workspace drive, including on Windows.
const temporaryDirectory = resolve(".cache/test-tmp");
mkdirSync(temporaryDirectory, { recursive: true });
export default defineConfig({
  test: {
    include: ["tests/**/*.integration.test.ts"],
    testTimeout: 60000,
    hookTimeout: 600000,
    env: {
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      TMPDIR: temporaryDirectory,
    },
  },
});
