// How "smart" a model should be considered relative to others. The scale is
// shared by every provider, so levels are comparable across online and local
// models: a higher number should be preferred for harder tasks.
export const SOPHISTICATION = Object.freeze({
  ZERO: 0, // system-only models: classification, routing, not for replies
  BASIC: 1, // small local models: simple rewrites, classification
  CAPABLE: 2, // mid-size local models, small hosted models
  STRONG: 3, // large local models, mid-tier hosted models
  ADVANCED: 4, // top general-purpose hosted models
  FRONTIER: 5, // the most capable models available
});

interface HostedRules {
  rules: [RegExp, number][];
  fallback: number;
}

// Per hosted provider: name patterns (first match wins) and a default level.
const HOSTED_RULES: Record<string, HostedRules> = {
  anthropic: {
    rules: [
      [/fable|mythos/, SOPHISTICATION.FRONTIER],
      [/opus/, SOPHISTICATION.ADVANCED],
      [/sonnet/, SOPHISTICATION.STRONG],
      [/haiku/, SOPHISTICATION.CAPABLE],
    ],
    fallback: SOPHISTICATION.STRONG,
  },
  openai: {
    rules: [
      [/nano/, SOPHISTICATION.BASIC],
      [/mini|gpt-3\.5/, SOPHISTICATION.CAPABLE],
      [/pro/, SOPHISTICATION.FRONTIER],
    ],
    fallback: SOPHISTICATION.ADVANCED,
  },
};

// Local servers only report a model name, so estimate from the parameter
// count most names carry ("llama3.2:3b", "mistral-7b", "qwen2.5-coder:32b").
// Applies to every non-hosted provider (local, lmstudio, unknown).
function fromParameterCount(modelId: string): number {
  const match = /(\d+(?:\.\d+)?)b\b/i.exec(modelId);
  if (!match) return SOPHISTICATION.ZERO;
  const billions = parseFloat(match[1]);
  // original default - 1, floored at 0
  if (billions >= 30) return SOPHISTICATION.CAPABLE;
  if (billions >= 5) return SOPHISTICATION.BASIC;
  return SOPHISTICATION.ZERO;
}

// Manual levels keyed by "provider/model"; these win over the rules above.
let overrides: Record<string, number> = {};

export function setOverrides(map: Record<string, number> | undefined): void {
  overrides = map ?? {};
}

export function resolveSophistication(providerId: string, modelId: string): number {
  const override = overrides[`${providerId}/${modelId}`];
  if (override !== undefined) return override;

  const hosted = HOSTED_RULES[providerId];
  if (hosted) {
    const rule = hosted.rules.find(([pattern]) => pattern.test(modelId));
    return rule ? rule[1] : hosted.fallback;
  }
  // Non-hosted providers (local, lmstudio, unknown): estimate from the parameter count
  return fromParameterCount(modelId);
}

// Sort comparator: most sophisticated first.
export function bySophistication(a: { sophistication: number }, b: { sophistication: number }): number {
  return b.sophistication - a.sophistication;
}
