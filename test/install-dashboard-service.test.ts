import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SCRIPT = readFileSync(new URL("../scripts/install-dashboard-service.sh", import.meta.url), "utf8");

test("install-dashboard-service.sh defaults DASHBOARD_HOST to loopback", () => {
  assert.match(SCRIPT, /HOST="\$\{DASHBOARD_HOST:-127\.0\.0\.1\}"/);
});

test("install-dashboard-service.sh opts a non-loopback DASHBOARD_HOST into --allow-remote with a warning", () => {
  assert.match(SCRIPT, /--allow-remote/);
  assert.match(SCRIPT, /WARNING:.*not loopback/);
});
