import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

test("macOS status bar app is wired to the compact dashboard URL and offline state", () => {
  const source = readFileSync("macos/DispatcherStatusBar/Sources/DispatcherStatusBar.swift", "utf8");
  assert.match(source, /http:\/\/192\.168\.0\.240:8787\/compact/);
  assert.match(source, /NSStatusBar\.system\.statusItem/);
  assert.match(source, /Dispatcher unavailable/);
  assert.match(source, /WKWebView/);

  const plist = readFileSync("macos/DispatcherStatusBar/Info.plist", "utf8");
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
  assert.match(plist, /NSAllowsLocalNetworking/);
  assert.match(plist, /NSAllowsArbitraryLoadsInWebContent/);
});

test("macOS status bar install instructions cover build, launch, and login autorun", () => {
  const docs = readFileSync("docs/macos-menu-bar.md", "utf8");
  assert.match(docs, /http:\/\/<dispatcher-host>:8787\/compact/);
  assert.match(docs, /macos\/DispatcherStatusBar\/build\.sh/);
  assert.match(docs, /open "\/Applications\/Dispatcher Status Bar\.app"/);
  assert.match(docs, /Login Items & Extensions/);
  assert.match(docs, /launchctl bootstrap/);

  const buildMode = statSync("macos/DispatcherStatusBar/build.sh").mode;
  assert.equal((buildMode & 0o111) !== 0, true);
});
