// Provider registry. To add a provider: write an adapter file exposing
// { id, isConfigured(), complete({...}) → { text, usage } } and list it here.
// Its id is what LLM_PROVIDER / LLM_FALLBACKS refer to.
import openai from './openai.js';
import gemini from './gemini.js';

export const PROVIDERS = { [openai.id]: openai, [gemini.id]: gemini };

export function getProvider(id) {
  return PROVIDERS[id] ?? null;
}
