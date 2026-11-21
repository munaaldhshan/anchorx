// Default primary provider: GitHub Models (OpenAI-compatible). Point
// LLM_BASE_URL at api.openai.com/v1, Azure, etc. to use another host.
import { createOpenAICompatibleProvider } from './openaiCompatible.js';

export default createOpenAICompatibleProvider({
  id:             'openai',
  apiKeyEnv:      'LLM_API_KEY',
  baseUrlEnv:     'LLM_BASE_URL',
  defaultBaseUrl: 'https://models.github.ai/inference',
});
