// src/targets.mjs
// For harnesses whose config lives in an opaque VS Code store (Kilo, Cline, Roo, ZCode, DeepSeek Harness)
// we can't safely patch the internal DB, so we produce exact field-by-field guidance + a copyable manifest.

import { FORMATS } from "./formats.mjs";

export const TARGETS = [
  { id: "kilo", label: "Kilo Code" },
  { id: "cline", label: "Cline" },
  { id: "roo", label: "Roo Code" },
  { id: "zcode", label: "ZCode" },
  { id: "deepseek-harness", label: "DeepSeek Harness" },
  { id: "generic", label: "Generic / other" },
];

// The manifest is meant to be copied into another tool's UI, so it must never
// carry the literal key: describe where the key lives instead.
function keyPlaceholder(provider) {
  if (provider.useEnvVar && provider.envVarName) return `<значение переменной ${provider.envVarName}>`;
  return provider.apiKey ? "<вставь свой API-ключ>" : "";
}

// Returns a plain-JSON manifest that mirrors exactly what the UI collects.
// Useful for tools that import a JSON provider manifest.
export function buildManifest(provider) {
  return {
    provider: {
      name: provider.name,
      baseURL: provider.baseURL,
      apiFormat: provider.apiFormat,
      apiFormatLabel: (FORMATS[provider.apiFormat] || FORMATS["openai-chat"]).label,
      apiKey: keyPlaceholder(provider),
      models: (provider.models || []).map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: Number(m.contextWindow) || 0,
        maxOutput: Number(m.maxOutput) || 0,
        inputTypes: m.inputTypes || ["text"],
        outputTypes: m.outputTypes || ["text"],
        reasoning: !!m.reasoning,
      })),
    },
  };
}

// Human step-by-step guide tuned to the Kilo/Cline-style Model settings UI.
export function buildGuide(provider, target) {
  const fmt = FORMATS[provider.apiFormat] || FORMATS["openai-chat"];
  const lines = [];
  lines.push(`## ${provider.name} → ${target.label}`);
  lines.push("");
  lines.push("1. Открой Model settings → Add provider.");
  lines.push("2. Name: `" + provider.name + "`");
  lines.push("3. Base URL: `" + (provider.baseURL || "") + "`");
  lines.push(
    provider.useEnvVar && provider.envVarName
      ? "4. API key: вставь значение переменной `" + provider.envVarName + "` (`$env:" + provider.envVarName + "` в PowerShell)"
      : "4. API key: вставь свой ключ вручную"
  );
  lines.push("5. API format: «" + fmt.label + "»");
  lines.push("6. Add model — по одной для каждой модели:");
  lines.push("");
  for (const m of provider.models || []) {
    lines.push(`   - Model ID: \`${m.id || ""}\``);
  }
  lines.push("");
  lines.push(`Совет: ${fmt.note}`);
  return lines.join("\n");
}
