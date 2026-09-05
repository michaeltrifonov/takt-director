export interface AskContext {
  options?: string[];
  context?: string;
}

/**
 * Thin client for the director's consult endpoint. Used by the ask_takt MCP shim
 * (Claude -> director consult). Targets the server endpoint `POST {consultPath}`,
 * which returns `{ answer: string }` and authenticates via the `X-API-Key` header.
 */
export class TaktClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly consultPath: string = '/api/consult/ask',
  ) {}

  async ask(question: string, ctx: AskContext = {}): Promise<string> {
    const res = await fetch(new URL(this.consultPath, this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
      },
      body: JSON.stringify({ question, ...ctx }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`consult failed: ${res.status} ${body}`);
    }

    const data = (await res.json().catch(() => ({}))) as { answer?: string; text?: string };
    return data.answer ?? data.text ?? '';
  }
}
