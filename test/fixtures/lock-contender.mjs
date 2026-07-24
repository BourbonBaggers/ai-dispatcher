import { appendFileSync, existsSync } from "node:fs";
import { StateStore, LockHeldError } from "../../src/state.ts";

const [, , stateDir, readyFile, startFile, releaseFile, winnersFile] = process.argv;

const waitFor = async (path) => {
  while (!existsSync(path)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

try {
  appendFileSync(readyFile, `${process.pid}\n`);
  await waitFor(startFile);
  const store = StateStore.open(stateDir);
  appendFileSync(winnersFile, `${process.pid}\n`);
  await waitFor(releaseFile);
  store.releaseLock();
  process.exitCode = 0;
} catch (error) {
  if (error instanceof LockHeldError) {
    process.exitCode = 2;
  } else {
    throw error;
  }
}
