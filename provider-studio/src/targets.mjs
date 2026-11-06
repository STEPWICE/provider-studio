// src/targets.mjs
// For harnesses whose config lives in an opaque VS Code store (Kilo, Cline,
// Roo Code) we can't safely patch the internal DB, so we produce exact
// field-by-field guidance + a copyable manifest.

import { FORMATS } from "./formats.mjs";

// Только реально существующие харнесы: мёртвые кнопки путеводителя хуже, чем
// их отсутствие — уводят настраивать то, чего нет. Остальное покрывает
// «Generic / other» (сервер принимает и неизвестные id через fallback).
export const TARGETS = [
  { id: "kilo", label: "Kilo Code", kind: "write", hint: "Пишется в ~/.config/kilo/kilo.json(c)" },
  { id: "cline", label: "Cline", kind: "guide" },
  { id: "roo", label: "Roo Code", kind: "guide" },
  { id: "workbuddy", label: "WorkBuddy AI", kind: "write", hint: "Пишется в ~/.codebuddy/models.json" },
  { id: "openchamber", label: "OpenChamber", kind: "auto", hint: "Читает конфиг OpenCode" },
  { id: "verdent", label: "Verdent (BYOA)", kind: "guide", hint: "Anthropic-совместимый endpoint" },
  { id: "qoder", label: "Qoder", kind: "guide", hint: "Settings → Models → Custom endpoint" },
  { id: "kiro", label: "Kiro", kind: "proxy", hint: "Только TUN: custom endpoint не поддерживается" },
  { id: "generic", label: "Generic / other", kind: "guide" },
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

// Human step-by-step guide tuned to each harness. Kilo and WorkBuddy are also
// written by the server (the guide then says so); the rest are copy/paste.
export function buildGuide(provider, target) {
  const fmt = FORMATS[provider.apiFormat] || FORMATS["openai-chat"];
  const lines = [];
  lines.push(`## ${provider.name} → ${target.label}`);
  lines.push("");

  if (target.id === "kilo") {
    lines.push("Студия сама запишет провайдера в `~/.config/kilo/kilo.json(c)`.");
    lines.push("После записи перезапусти Kilo Desktop/CLI.");
    lines.push(`Base URL: \`${provider.baseURL || ""}\`, формат: «${fmt.label}».`);
    return lines.join("\n");
  }

  if (target.id === "workbuddy") {
    lines.push("Студия сама запишет модели в `~/.codebuddy/models.json`.");
    lines.push("После записи перезапусти WorkBuddy AI.");
    lines.push(`URL: \`${provider.baseURL || ""}\`, ключ: ${provider.useEnvVar ? "`${" + provider.envVarName + "}`" : "в файле"}.`);
    return lines.join("\n");
  }

  if (target.id === "openchamber") {
    lines.push("OpenChamber читает список провайдеров OpenCode.");
    lines.push("Примени провайдера к opencode — после этого перезапусти OpenChamber.");
    lines.push("Отдельный конфиг OpenChamber писать не нужно.");
    return lines.join("\n");
  }

  if (target.id === "verdent") {
    lines.push("Verdent Manager → Settings → Models → CLI Agents.");
    lines.push("Выбери Claude Code → Add provider → Custom endpoint.");
    lines.push("Verdent принимает Anthropic-формат, не OpenAI Chat.");
    if (String(provider.apiFormat || "").includes("anthropic")) {
      lines.push(`Base URL: \`${provider.baseURL || ""}\``);
      lines.push("Модели: " + (provider.models || []).map((m) => `\`${m.id}\``).join(", "));
    } else {
      lines.push("Для этого провайдера нужен Anthropic-совместимый маршрут.");
      lines.push("Пример: TokenHarbor `https://tokenharbor.ai/v1` (проверен `/v1/messages`), модель `deepseek-v4.1-flash:free`.");
      lines.push("Либо OpenRouter `https://openrouter.ai/api` для Claude Code.");
    }
    return lines.join("\n");
  }

  if (target.id === "qoder") {
    lines.push("Qoder Desktop: Settings → Models → Add model → Provider → Custom.");
    lines.push("Выбери **OpenAI Compatible** → Chat Completions API (или Anthropic Compatible).");
    lines.push(`Base URL: \`${provider.baseURL || ""}\``);
    lines.push("API key: ключ провайдера; Model ID — по одному на модель:");
    for (const m of provider.models || []) lines.push(`   - \`${m.id || ""}\``);
    lines.push("Укажи context window / Vision / Thinking по возможностям модели и нажми «Validate and add model».");
    lines.push("Qoder CLI: `/model` → Custom → Add custom model; вручную в settings.json BYOK не прописывается.");
    return lines.join("\n");
  }

  if (target.id === "kiro") {
    lines.push("Kiro пока не принимает custom base URL / OpenAI-совместимые провайдеры:");
    lines.push("BYOK отслеживается в kirodotdev/Kiro#3115.");
    lines.push("Единственный вариант — сетевой прокси (TUN в v2rayN).");
    return lines.join("\n");
  }

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
