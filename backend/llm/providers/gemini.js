// Google Gemini via the REST generateContent endpoint (no SDK: plain fetch
// gives us real AbortSignal timeouts and uniform error handling).
import { LLMError, parseRetryAfter } from '../errors.js';
import { toGeminiSchema } from '../schema.js';

const baseUrl = () => (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');

// Gemini 429 bodies carry RetryInfo { retryDelay: "13s" } instead of a header.
function retryDelayFromBody(body) {
  const info = body?.error?.details?.find?.(d => typeof d?.retryDelay === 'string');
  const m = info?.retryDelay?.match(/^([\d.]+)s$/);
  return m ? Number(m[1]) * 1000 : null;
}

function toGeminiContents(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  return { system, contents };
}

export default {
  id: 'gemini',
  isConfigured: () => Boolean(process.env.GEMINI_API_KEY),

  async complete({ model, messages, jsonSchema, temperature, maxTokens, signal }) {
    const { system, contents } = toGeminiContents(messages);

    // 2.5-flash "thinks" by default and thinking tokens eat maxOutputTokens,
    // truncating JSON. Budget 0 disables it; set GEMINI_THINKING_BUDGET='' to
    // omit the field for models that reject it.
    const budget = process.env.GEMINI_THINKING_BUDGET ?? '0';
    const generationConfig = {
      temperature,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      ...(jsonSchema ? { responseSchema: toGeminiSchema(jsonSchema) } : {}),
      ...(budget !== '' ? { thinkingConfig: { thinkingBudget: Number(budget) } } : {}),
    };

    const res = await fetch(`${baseUrl()}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig,
      }),
    });

    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON body */ }
      const detail = body?.error?.message ?? '';
      throw new LLMError(`gemini request failed (${res.status})${detail ? `: ${detail}` : ''}`, {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after')) ?? retryDelayFromBody(body),
      });
    }

    const data = await res.json();
    const cand = data?.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map(p => p.text ?? '').join('');
    if (!text.trim())
      throw new LLMError(`gemini returned an empty response (finishReason=${cand?.finishReason ?? 'none'})`, { code: 'BAD_RESPONSE' });

    return {
      text,
      usage: {
        inputTokens:  data?.usageMetadata?.promptTokenCount     ?? null,
        outputTokens: data?.usageMetadata?.candidatesTokenCount ?? null,
      },
    };
  },
};
