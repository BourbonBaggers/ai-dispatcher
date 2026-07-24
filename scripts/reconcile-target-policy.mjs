#!/usr/bin/env node
import { reconcileTargetPolicy } from "../src/target-policy.ts";

const checkout = process.argv[2];
if (!checkout) {
  console.error("usage: reconcile-target-policy.mjs <checkout>");
  process.exit(64);
}

try {
  const result = await reconcileTargetPolicy(checkout, process.env);
  if (!result.active || !result.verified) {
    console.error("dispatcher target policy reconciliation requires trusted launch context");
    process.exit(65);
  }
  console.log(result.policyPath);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`dispatcher target policy reconciliation failed: ${message}`);
  process.exit(1);
}
