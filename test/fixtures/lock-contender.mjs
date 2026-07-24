import { appendFileSync } from "node:fs";
import { StateStore, LockHeldError } from "../../src/state.ts";

const [, , stateDir, winnersFile] = process.argv;

try {
  const store = StateStore.open(stateDir);
  appendFileSync(winnersFile, `${process.pid}\n`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  store.releaseLock();
  process.exitCode = 0;
} catch (error) {
  if (error instanceof LockHeldError) {
    process.exitCode = 2;
  } else {
    throw error;
  }
}
