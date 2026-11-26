import { test } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { discoverProviderModels, normalizeProviderUrl, providerInput, testProviderConnection } from "./agent-provider.ts";

test("normalizes HTTP(S) URLs and rejects embedded credentials and other protocols", () => {
  assert.equal(normalizeProviderUrl(" http://localhost:11434/v1/ "), "http://localhost:11434/v1");
  for (const url of ["ftp://host", "https://key@host/v1", "https://host/v1?key=secret", "https://host/v1#fragment", "not a URL"]) {
    assert.throws(() => normalizeProviderUrl(url));
  }
});

test("saved key is reused only for the same normalized server; explicit empty key removes it from the probe", () => {
  const saved = { baseUrl: "https://example.test/v1", apiKey: "saved-key" };
  assert.equal(providerInput({ baseUrl: "https://example.test/v1/" }, saved).apiKey, "saved-key");
  assert.equal(providerInput({ baseUrl: "https://other.test/v1" }, saved).apiKey, undefined);
  assert.equal(providerInput({ baseUrl: "https://example.test/v2" }, saved).apiKey, undefined);
  assert.equal(providerInput({ baseUrl: saved.baseUrl, apiKey: "" }, saved).apiKey, "");
  assert.equal(providerInput({ baseUrl: saved.baseUrl, apiKey: "replacement" }, saved).apiKey, "replacement");
});

test("real loopback HTTP flow discovers models, authenticates and sends a chat probe", async () => {
  const seen: { url?: string; method?: string; auth?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "z" }, { id: "a" }, { id: "a" }, { id: 7 }, null] }));
    else res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const settings = { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fake-key", model: "a" };
    assert.deepEqual(await discoverProviderModels(settings), ["a", "z"]);
    await testProviderConnection(settings);
    assert.deepEqual(seen.map(({ url, method, auth }) => [url, method, auth]), [["/v1/models", "GET", "Bearer fake-key"], ["/v1/chat/completions", "POST", "Bearer fake-key"]]);
    assert.equal(JSON.parse(seen[1]!.body).model, "a");
    assert.equal(JSON.parse(seen[1]!.body).stream, false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("HTTP failures, malformed lists and completions are reported without upstream secrets", async () => {
  const settings = { baseUrl: "https://example.test/v1", model: "a", apiKey: "secret" };
  const unauthorized = (async () => new Response("secret", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(discoverProviderModels(settings, unauthorized), /HTTP 401/);
  const bad = (async () => Response.json({})) as unknown as typeof fetch;
  await assert.rejects(discoverProviderModels(settings, bad), /model list/);
  await assert.rejects(testProviderConnection(settings, bad), /chat completion/);
  await assert.rejects(testProviderConnection({ ...settings, model: "" }, bad), /model name/);
});
