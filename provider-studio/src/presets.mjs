// Ready-made provider entries for the setup wizard.
//
// Why this exists: the single hardest question for a newcomer is "what do I put
// in Base URL?". Getting it wrong fails silently much later — opencode starts,
// then every request 404s. A preset carries the exact base URL, the API format
// and the conventional environment-variable name, so the only thing left to
// type is the key itself.
//
// Deliberately data-only: no network calls, no fs. `apiFormat` values must be
// keys of FORMATS in ./formats.mjs — verify-formats.mjs asserts that.
//
// `freeTier` describes what the provider gives away, and it carries the date it
// was last checked. Free tiers change without notice — while writing these,
// Cerebras had removed its always-free tier ("Is there a permanently free tier?
// No") and GitHub Models was answering 410 github_models_retirement_brownout,
// both of which are still listed as free in third-party roundups. An
// unattributed, undated number is worse than none: it reads as current.
// The rule for editing this file: every `freeTier.limits` line must be
// something the provider states, with `source` pointing at where it says so.

/** Date the free-tier notes below were last checked against the providers. */
export const FREE_TIER_CHECKED = "2026-08-29";

export const PRESETS = [
  {
    id: "openrouter",
    label: "OpenRouter",
    hint: "Шлюз к сотням моделей, есть бесплатные.",
    baseURL: "https://openrouter.ai/api/v1",
    apiFormat: "openai-chat",
    envVarName: "OPENROUTER_API_KEY",
    keyURL: "https://openrouter.ai/keys",
    needsKey: true,
    // Discovery works, so we do not ship a model list that would go stale.
    discover: true,
    freeTier: {
      // Counted live from /api/v1/models: models priced at 0/0. The count moves
      // week to week, so it is described as approximate on purpose.
      summary: "Модели с суффиксом «:free» — около 20 штук, цена 0/0.",
      limits: [
        "Бесплатные модели помечены «:free» прямо в списке — их видно при обнаружении.",
        "Лимит зависит от баланса аккаунта; точные цифры OpenRouter показывает в личном кабинете.",
      ],
      source: "https://openrouter.ai/docs/api-reference/limits",
      checked: FREE_TIER_CHECKED,
    },
  },
  {
    id: "google-ai-studio",
    label: "Google AI Studio (Gemini)",
    hint: "Бесплатный тариф Gemini. OpenAI-совместимый путь.",
    // Verified live: POST to this base returns 400 "Missing or invalid
    // Authorization header", i.e. the path exists and only wants a key. The
    // native /v1beta/models path answers 403 for unregistered callers.
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiFormat: "openai-chat",
    envVarName: "GEMINI_API_KEY",
    keyURL: "https://aistudio.google.com/apikey",
    needsKey: true,
    // Discovery works despite a confusing unauthenticated response: GET
    // /v1beta/openai/models answers 404 "Requested entity was not found" with
    // no key, but 400 "Please pass a valid API key" once an Authorization
    // header is present. So the endpoint exists and only wants a real key —
    // the 404 is not a missing route.
    discover: true,
    freeTier: {
      summary: "Есть бесплатный тариф; лимиты зависят от модели.",
      limits: [
        "Лимиты считаются по трём осям сразу: запросы в минуту, токены в минуту и запросы в сутки.",
        "Суточный счётчик обнуляется в полночь по тихоокеанскому времени.",
        "Лимит общий на проект, а не на ключ.",
        "Точные числа для каждой модели Google показывает только в AI Studio — здесь их нет намеренно.",
      ],
      source: "https://ai.google.dev/gemini-api/docs/rate-limits",
      checked: FREE_TIER_CHECKED,
    },
  },
  {
    id: "nvidia-nim",
    label: "NVIDIA NIM",
    hint: "Каталог открытых моделей, есть пробные кредиты.",
    // Verified live: /v1/models answers 200 without a key and lists 83 models.
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiFormat: "openai-chat",
    envVarName: "NVIDIA_API_KEY",
    keyURL: "https://build.nvidia.com/settings/api-keys",
    needsKey: true,
    discover: true,
    freeTier: {
      summary: "Пробные кредиты на аккаунт, дальше — платно.",
      limits: ["Размер и срок кредитов NVIDIA публикует в личном кабинете, единого числа нет."],
      source: "https://build.nvidia.com/",
      checked: FREE_TIER_CHECKED,
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    hint: "Дешёвые chat и reasoner модели.",
    baseURL: "https://api.deepseek.com/v1",
    apiFormat: "openai-chat",
    envVarName: "DEEPSEEK_API_KEY",
    keyURL: "https://platform.deepseek.com/api_keys",
    needsKey: true,
    discover: true,
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    hint: "Прямой доступ к Claude по ключу Anthropic.",
    baseURL: "https://api.anthropic.com/v1",
    apiFormat: "anthropic",
    envVarName: "ANTHROPIC_API_KEY",
    keyURL: "https://console.anthropic.com/settings/keys",
    needsKey: true,
    // Anthropic has no public /models listing for every plan, so seed the
    // catalogue instead of leaving the user with an empty list.
    discover: false,
    models: [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200000, maxOutput: 64000, inputTypes: ["text", "image"], outputTypes: ["text"], reasoning: true, toolUse: true },
      { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", contextWindow: 200000, maxOutput: 8192, inputTypes: ["text", "image"], outputTypes: ["text"], reasoning: false, toolUse: true },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    hint: "GPT по ключу OpenAI.",
    baseURL: "https://api.openai.com/v1",
    apiFormat: "openai-chat",
    envVarName: "OPENAI_API_KEY",
    keyURL: "https://platform.openai.com/api-keys",
    needsKey: true,
    discover: true,
  },
  {
    id: "groq",
    label: "Groq",
    hint: "Очень быстрый инференс открытых моделей.",
    baseURL: "https://api.groq.com/openai/v1",
    apiFormat: "openai-chat",
    envVarName: "GROQ_API_KEY",
    keyURL: "https://console.groq.com/keys",
    needsKey: true,
    discover: true,
    freeTier: {
      summary: "Бесплатный доступ с лимитами на каждую модель отдельно.",
      limits: [
        "Лимиты у каждой модели свои: запросы в минуту и в сутки, токены в минуту и в сутки.",
        "Лимит общий на организацию, а не на пользователя.",
        "Кэшированные токены в лимит не засчитываются.",
        "Свои точные значения видно на странице limits в консоли Groq.",
      ],
      source: "https://console.groq.com/docs/rate-limits",
      checked: FREE_TIER_CHECKED,
    },
  },
  {
    id: "together",
    label: "Together AI",
    hint: "Открытые модели, оплата по токенам.",
    baseURL: "https://api.together.xyz/v1",
    apiFormat: "openai-chat",
    envVarName: "TOGETHER_API_KEY",
    keyURL: "https://api.together.xyz/settings/api-keys",
    needsKey: true,
    discover: true,
  },
  {
    id: "mistral",
    label: "Mistral",
    hint: "Модели Mistral и Codestral.",
    baseURL: "https://api.mistral.ai/v1",
    apiFormat: "openai-chat",
    envVarName: "MISTRAL_API_KEY",
    keyURL: "https://console.mistral.ai/api-keys",
    needsKey: true,
    discover: true,
  },
  {
    id: "cerebras",
    label: "Cerebras",
    hint: "Очень быстрый инференс. Постоянного бесплатного тарифа нет.",
    baseURL: "https://api.cerebras.ai/v1",
    apiFormat: "openai-chat",
    envVarName: "CEREBRAS_API_KEY",
    keyURL: "https://cloud.cerebras.ai/",
    needsKey: true,
    discover: true,
    freeTier: {
      // Included precisely because the internet still lists Cerebras as
      // "1M tokens/day free". Their own docs now say otherwise, and a user
      // planning around the old number would be planning around nothing.
      summary: "Постоянного бесплатного тарифа нет — только пробные кредиты.",
      limits: [
        "$5 кредитов после привязки карты, сгорают через 30 дней.",
        "Когда кредиты кончились, доступ к API останавливается до покупки.",
        "В сторонних подборках Cerebras до сих пор числится как «1M токенов в день бесплатно» — это устарело.",
      ],
      source: "https://inference-docs.cerebras.ai/support/rate-limits",
      checked: FREE_TIER_CHECKED,
    },
  },
  {
    // Base URL — из живого рабочего конфига (проверен в деле, а не из доков).
    id: "xkiro",
    label: "Xkiro",
    hint: "Шлюз с моделями Qwen/DeepSeek/Mistral, есть бесплатные с суффиксом :free.",
    baseURL: "https://api.xkiro.com/v1",
    apiFormat: "openai-chat",
    envVarName: "XKIRO_API_KEY",
    needsKey: true,
    discover: true,
    // Seed — запасной список на случай, если обнаружение не сработает.
    // Снят с живого /v1/models 2026-09-17 (109 моделей, :free — 26 штук):
    // только id, без характеристик — их подтянет обнаружение или каталог.
    // Протухает: сверяй с живым списком, суффикс :free — маркер бесплатности.
    models: [
      { id: "qwen/qwen3.7-flash:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.6-max-preview:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.5-plus:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3-max:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.5-flash:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.8-max:free", free: true, freeSource: "name" },
      { id: "minimax/minimax-m3:free", free: true, freeSource: "name" },
      { id: "minimax/minimax-m2.7:free", free: true, freeSource: "name" },
      { id: "minimax/minimax-m2.5-highspeed:free", free: true, freeSource: "name" },
      { id: "minimax/minimax-m2:free", free: true, freeSource: "name" },
      { id: "minimax/minimax-m2.7-highspeed:free", free: true, freeSource: "name" },
      { id: "minimax/minimax-m2.5:free", free: true, freeSource: "name" },
      { id: "minimax/minimax-m2.1:free", free: true, freeSource: "name" },
      { id: "minimax/minimax-m2.1-highspeed:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.7-plus:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.6-plus:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.5-omni-plus:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.7-max:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.5-397b-a17b:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.5-omni-flash:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.6-27b:free", free: true, freeSource: "name" },
      { id: "qwen/qwen-plus-2025-07-28:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3-vl-plus:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3-omni-flash:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3.6-35b-a3b:free", free: true, freeSource: "name" },
      { id: "qwen/qwen3-coder-plus:free", free: true, freeSource: "name" },
    ],
  },
  {
    // Локальный роутер: адрес и поведение — из живого конфига. Ключ не нужен,
    // но сам GoRouter должен быть запущен, иначе пробы честно скажут «отклонено».
    id: "gorouter",
    label: "GoRouter (локально)",
    hint: "Локальный роутер. Ключ не нужен, но GoRouter должен быть запущен.",
    baseURL: "http://localhost:14747/v1",
    apiFormat: "openai-chat",
    envVarName: "",
    needsKey: false,
    local: true,
    discover: true,
  },
  {
    id: "zai",
    label: "Z.ai (GLM)",
    hint: "Модели GLM, OpenAI-совместимый эндпоинт.",
    baseURL: "https://api.z.ai/api/paas/v4",
    apiFormat: "openai-chat",
    envVarName: "ZAI_API_KEY",
    keyURL: "https://z.ai/manage-apikey/apikey-list",
    needsKey: true,
    discover: true,
  },
  {
    id: "ollama",
    label: "Ollama (локально)",
    hint: "Локальные модели. Ключ не нужен, но Ollama должен быть запущен.",
    baseURL: "http://localhost:11434/v1",
    apiFormat: "openai-chat",
    envVarName: "",
    keyURL: "https://ollama.com/download",
    // Local servers ignore the key entirely; demanding one would be a dead end.
    needsKey: false,
    local: true,
    discover: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio (локально)",
    hint: "Локальный сервер LM Studio. Включи Local Server в приложении.",
    baseURL: "http://localhost:1234/v1",
    apiFormat: "openai-chat",
    envVarName: "",
    needsKey: false,
    local: true,
    discover: true,
  },
  {
    id: "custom",
    label: "Другой (вручную)",
    hint: "Любой OpenAI- или Anthropic-совместимый эндпоинт.",
    baseURL: "",
    apiFormat: "openai-chat",
    envVarName: "",
    needsKey: true,
    discover: true,
  },
];

// Guessing the wire format from the URL saves a decision the user cannot make
// confidently. Only used as a default: the picker stays editable.
export function detectFormatFromURL(baseURL) {
  const u = String(baseURL || "").toLowerCase();
  if (!u) return "";
  if (u.includes("api.anthropic.com")) return "anthropic";
  if (/\/v1\/messages\/?$/.test(u)) return "anthropic";
  if (/\/responses\/?$/.test(u)) return "openai-responses";
  return "openai-chat";
}

export function findPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}
