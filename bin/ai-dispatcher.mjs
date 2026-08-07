#!/usr/bin/env node
// Executable entrypoint. Node 24 strips TypeScript types natively, so this thin .mjs
// shim just imports the real entrypoint and forwards the process exit code.
//
// argv is sliced to drop `node` and this script path, leaving only the dispatcher's own
// flags (--repo, --once, --dry-run, …).
import { main } from "../src/main.ts";
import { loadEnvFile, DEFAULT_ENV_FILE } from "../src/setup.ts";
import { fileURLToPath } from "node:url";

// Explicit shell variables win; these files provide the first-run defaults created by
// `ai-dispatcher init` and the conventional local `.env` fallback.
loadEnvFile(DEFAULT_ENV_FILE, process.env);
loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)), process.env);

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`ai-dispatcher: fatal: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
