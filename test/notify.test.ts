import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNotifier,
  NOTIFY_PRIORITY_DEFAULT,
  NOTIFY_PRIORITY_HIGH,
} from "../src/notify.ts";

test("an unconfigured notifier is a silent no-op (never touches the network)", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response();
  }) as typeof fetch;
  try {
    const notifier = createNotifier({ ntfyUrl: null, ntfyTopic: null });
    await notifier.send("t", "b");
    const halfConfigured = createNotifier({ ntfyUrl: "https://ntfy.sh", ntfyTopic: null });
    await halfConfigured.send("t", "b");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("a configured notifier POSTs to <url>/<topic> with title + priority headers", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response();
  }) as typeof fetch;
  try {
    // Trailing slashes on the base URL must not double up.
    const notifier = createNotifier({ ntfyUrl: "https://ntfy.sh/", ntfyTopic: "dispatch" });
    await notifier.send("Title here", "Body here", NOTIFY_PRIORITY_HIGH);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://ntfy.sh/dispatch");
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal(calls[0]!.init.body, "Body here");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Title, "Title here");
    assert.equal(headers.Priority, String(NOTIFY_PRIORITY_HIGH));
  } finally {
    globalThis.fetch = original;
  }
});

test("send defaults to the normal priority and never throws on a network error", async () => {
  const original = globalThis.fetch;
  let seenPriority: string | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seenPriority = (init.headers as Record<string, string>).Priority;
    throw new Error("network down");
  }) as typeof fetch;
  try {
    const notifier = createNotifier({ ntfyUrl: "https://ntfy.sh", ntfyTopic: "dispatch" });
    // A failed push must not propagate — delivery is best-effort.
    await notifier.send("t", "b");
    assert.equal(seenPriority, String(NOTIFY_PRIORITY_DEFAULT));
  } finally {
    globalThis.fetch = original;
  }
});

test("a hung notification is aborted instead of freezing the dispatcher", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
  try {
    const notifier = createNotifier({
      ntfyUrl: "https://ntfy.sh",
      ntfyTopic: "dispatch",
      timeoutMs: 10,
    });
    const started = Date.now();
    await notifier.send("t", "b");
    assert.ok(Date.now() - started < 1_000);
  } finally {
    globalThis.fetch = original;
  }
});
