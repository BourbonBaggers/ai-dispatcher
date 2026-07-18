#!/usr/bin/env node
// Executable entrypoint. Node 24 strips TypeScript types natively, so this thin .mjs
// shim just imports the real entrypoint and forwards the process exit code.
//
// argv is sliced to drop `node` and this script path, leaving only the dispatcher's own
// flags (--repo, --once, --dry-run, …).
import { main } from "../src/main.ts";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`ai-dispatcher: fatal: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
