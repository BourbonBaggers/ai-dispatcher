#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchableModels } from "../src/models.ts";

const BEGIN = "<!-- BEGIN GENERATED LIVE MODEL LANES -->";
const END = "<!-- END GENERATED LIVE MODEL LANES -->";

function renderLiveModelLanes() {
  const rows = dispatchableModels().map((model) => {
    const frontier = model.frontier ? "**yes**" : "no";
    return `| ${model.tier} | ${model.role} | \`agent:${model.cli}\` | \`${model.modelLabel}\` | \`${model.cliModel}\` | \`${model.capacityPool}\` | ${frontier} |`;
  });

  return [
    BEGIN,
    "| Tier | Role | `agent:*` label | `model:*` label | CLI model | Pool | Frontier |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    END,
  ].join("\n");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routingPath = resolve(root, "ROUTING.md");
const routing = readFileSync(routingPath, "utf8");
const beginIndex = routing.indexOf(BEGIN);
const endIndex = routing.indexOf(END);

if (
  beginIndex === -1 ||
  endIndex === -1 ||
  beginIndex >= endIndex ||
  routing.indexOf(BEGIN, beginIndex + BEGIN.length) !== -1 ||
  routing.indexOf(END, endIndex + END.length) !== -1
) {
  throw new Error("ROUTING.md must contain exactly one valid generated live-model-lanes block");
}

const generated = renderLiveModelLanes();
const updated =
  routing.slice(0, beginIndex) +
  generated +
  routing.slice(endIndex + END.length);

if (updated !== routing) {
  writeFileSync(routingPath, updated);
  console.log("Updated ROUTING.md live model lanes from src/models.ts");
} else {
  console.log("ROUTING.md live model lanes are already current");
}
