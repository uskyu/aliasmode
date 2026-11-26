/** OpenAI-compatible provider discovery and connection probes. No settings are persisted. */
export class ProviderProbeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type ProviderInput = { baseUrl: string; apiKey?: string; model?: string };

export function normalizeProviderUrl(value: unknown): string {
  if (typeof value !== "string") throw new ProviderProbeError("Enter the model server URL");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new ProviderProbeError("Enter a valid model server URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderProbeError("Use an HTTP(S) model server URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

export function providerInput(input: unknown, saved: { baseUrl?: string; apiKey?: string }): ProviderInput {
  const body = (input ?? {}) as Record<string, unknown>;
  const baseUrl = normalizeProviderUrl(body.baseUrl);
  let savedUrl: string | undefined;
  try { savedUrl = normalizeProviderUrl(saved.baseUrl); } catch { /* no valid saved server */ }
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw new ProviderProbeError("Invalid API key");
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : baseUrl === savedUrl ? saved.apiKey : undefined;
  return { baseUrl, apiKey, model: typeof body.model === "string" ? body.model.trim() : undefined };
}

async function providerJson(settings: ProviderInput, path: string, body: object | undefined, fetchFn: typeof fetch): Promise<unknown> {
  const signal = AbortSignal.timeout(15000);
  try {
    const response = await fetchFn(`${settings.baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}),
        ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // Do not forward provider credentials to a redirected endpoint.
      redirect: "error", signal,
    });
    if (!response.ok) throw new ProviderProbeError(`Model server returned HTTP ${response.status}`, 502);
    return await response.json();
  } catch (error) {
    if (error instanceof ProviderProbeError) throw error;
    throw new ProviderProbeError(signal.aborted ? "Model server request timed out" : "Model server request failed or returned invalid JSON", 502);
  }
}

export async function discoverProviderModels(settings: ProviderInput, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const body = await providerJson(settings, "/models", undefined, fetchFn) as { data?: unknown } | null;
  if (!Array.isArray(body?.data)) throw new ProviderProbeError("Model server did not return an OpenAI model list", 502);
  return [...new Set(body.data.flatMap((item: unknown) => {
    const id = (item as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.trim() ? [id] : [];
  }))].sort((a, b) => a.localeCompare(b));
}

export async function testProviderConnection(settings: ProviderInput, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!settings.model) throw new ProviderProbeError("Enter the model name");
  const body = await providerJson(settings, "/chat/completions", {
    model: settings.model, messages: [{ role: "user", content: "Reply with OK." }], stream: false,
  }, fetchFn) as { choices?: { message?: { content?: unknown; tool_calls?: unknown } }[] } | null;
  const message = body?.choices?.[0]?.message;
  if (!message || (typeof message.content !== "string" && !Array.isArray(message.tool_calls))) {
    throw new ProviderProbeError("Model server did not return a chat completion", 502);
  }
}
