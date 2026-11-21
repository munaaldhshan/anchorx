// JSON-Schema helpers. Tasks declare one zod schema; we derive the
// provider-side structured-output schema from it. Providers only receive the
// structural part (types, enums, required, nesting) — numeric/string bounds
// are enforced by zod after the response arrives (with a corrective retry),
// because hosted structured-output modes reject many constraint keywords.
import { z } from 'zod';

const STRUCTURAL_KEYS = ['type', 'properties', 'required', 'items', 'enum', 'description', 'additionalProperties'];

function strip(node) {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const k of STRUCTURAL_KEYS) {
    if (!(k in node)) continue;
    if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(node.properties).map(([p, v]) => [p, strip(v)]));
    } else if (k === 'items') {
      out.items = strip(node.items);
    } else {
      out[k] = node[k];
    }
  }
  return out;
}

export function zodToJsonSchema(zodSchema) {
  return z.toJSONSchema(zodSchema);
}

/** OpenAI strict mode: every object closed, every property required. */
export function toStrictJsonSchema(jsonSchema) {
  const walk = (n) => {
    const s = strip(n);
    if (s.type === 'object') {
      s.additionalProperties = false;
      s.required = Object.keys(s.properties ?? {});
      for (const key of Object.keys(s.properties ?? {})) s.properties[key] = walk(n.properties[key]);
    } else if (s.type === 'array' && n.items) {
      s.items = walk(n.items);
    }
    return s;
  };
  return walk(jsonSchema);
}

/** Gemini responseSchema: OpenAPI-subset, upper-case types, no additionalProperties. */
export function toGeminiSchema(jsonSchema) {
  const walk = (n) => {
    const s = strip(n);
    delete s.additionalProperties;
    if (typeof s.type === 'string') s.type = s.type.toUpperCase();
    if (s.properties) {
      for (const key of Object.keys(s.properties)) s.properties[key] = walk(n.properties[key]);
    }
    if (n.items) s.items = walk(n.items);
    return s;
  };
  return walk(jsonSchema);
}
