// Adapter factory for any OpenAI-compatible /chat/completions endpoint
// (GitHub Models, OpenAI, Azure OpenAI, Groq, Mistral, OpenRouter, …).
// Adding another such provider is one file:
//
//   export default createOpenAICompatibleProvider({
//     id: 'groq', apiKeyEnv: 'GROQ_API_KEY', baseUrlEnv: 'GROQ_BASE_URL',
//     defaultBaseUrl: 'https://api.groq.com/openai/v1',
//   });
//
// …then register it in providers/index.js.
import { LLMError, parseRetryAfter } from '../errors.js';
import { toStrictJsonSchema } from '../schema.js';

export function createOpenAICompatibleProvider({ id, apiKeyEnv, baseUrlEnv, defaultBaseUrl, strictSchema = true }) {
  const apiKey  = () => process.env[apiKeyEnv];
  const baseUrl = () => (process.env[baseUrlEnv] || defaultBaseUrl).replace(/\/$/, '');

  return {
    id,
    isConfigured: () => Boolean(apiKey()),

    async complete({ model, messages, jsonSchema, schemaName, temperature, maxTokens, signal }) {
      const res = await fetch(`${baseUrl()}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          response_format: jsonSchema && strictSchema
            ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: toStrictJsonSchema(jsonSchema) } }
            : { type: 'json_object' },
        }),
      });

      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json())?.error?.message ?? ''; } catch { /* non-JSON body */ }
        throw new LLMError(`${id} request failed (${res.status})${detail ? `: ${detail}` : ''}`, {
          status: res.status,
          retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after')),
        });
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim())
        throw new LLMError(`${id} returned an empty response`, { code: 'BAD_RESPONSE' });

      return {
        text,
        usage: {
          inputTokens:  data?.usage?.prompt_tokens     ?? null,
          outputTokens: data?.usage?.completion_tokens ?? null,
        },
      };
    },
  };
}
