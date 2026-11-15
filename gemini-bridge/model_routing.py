"""Resolve web models from the account registry, never from guessed headers.

A model listed by Google is a selection candidate, not proof of generation.
The local orchestrator is a router, not Antigravity's multi-agent Orchestrator.
"""
from dataclasses import dataclass


class ModelSelectionError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


# Aliases of the same model, never substitutions between model families.
FAMILIES = {
    "hydrogen": ("gemini-4-hydrogen", "gemini-hydrogen"),
    "argon": ("gemini-4-argon", "gemini-argon"),
    "carbon": ("gemini-4-carbon", "gemini-carbon"),
    "pro": ("gemini-pro",),
    "lite": ("gemini-flash-lite",),
}
PUBLIC_MODELS = {
    "gemini-orchestrator": "Локальная маршрутизация (не Orchestrator Antigravity)",
    "gemini-4-hydrogen": "Gemini 4 Hydrogen",
    "gemini-4-hydrogen-high": "Gemini 4 Hydrogen (Thinking)",
    "gemini-4-argon": "Gemini 4 Argon",
    "gemini-4-argon-high": "Gemini 4 Argon (Thinking)",
    "gemini-4-carbon": "Gemini 4 Carbon",
    "gemini-carbon": "Gemini Carbon",
    "gemini-pro": "Gemini Pro",
    "gemini-flash-lite": "Gemini Flash Lite",
}


def selectable_models(models):
    return [m for m in models if getattr(m, "is_available", True)]


def identity_names(model):
    return {str(value).lower().strip() for value in (
        model.model_name, *(getattr(model, "aliases", None) or []),
    )}


def find_model(models, name):
    wanted = name.lower().strip()
    candidates = next((aliases for aliases in FAMILIES.values() if wanted in aliases), (wanted,))
    # Canonical names take priority over aliases when registries overlap.
    for candidate in candidates:
        for model in selectable_models(models):
            if model.model_name.lower() == candidate:
                return model
    for candidate in candidates:
        for model in selectable_models(models):
            if candidate in identity_names(model):
                return model
    return None


@dataclass(frozen=True)
class Selection:
    model: str
    thinking: bool
    router: bool = False


def select_model(models, requested, routed=None, routed_thinking=True):
    base, separator, modifier = requested.lower().strip().partition("@think=")
    override = None
    if separator:
        if modifier in ("true", "1", "on", "high"):
            override = True
        elif modifier in ("false", "0", "off", "none"):
            override = False
        else:
            raise ModelSelectionError("invalid_thinking_modifier", "Недопустимый модификатор @think.")
    if not models:
        raise ModelSelectionError("model_catalog_unknown", "Каталог Google ещё не получен; выбор модели не подтверждён.")

    router = base == "gemini-orchestrator"
    if router:
        # This is an explicitly automatic route, not a concrete-model fallback.
        if routed == "gemini-carbon":
            choices = ("gemini-4-argon", "gemini-4-hydrogen", "gemini-carbon")
        else:
            choices = (routed or "gemini-4-hydrogen", "gemini-4-hydrogen", "gemini-4-argon", "gemini-carbon")
        model = next((found for name in choices if (found := find_model(models, name))), None)
        thinking = routed_thinking
    else:
        # Recognise only documented bridge suffixes, never substring-match unknown IDs.
        high = base in ("gemini-4-hydrogen-high", "gemini-4-argon-high", "gemini-4-carbon-high")
        target = base[:-5] if high else base
        model = find_model(models, target)
        thinking = high or target in ("gemini-carbon", "gemini-4-carbon", "gemini-pro", "gemini-4-argon", "gemini-argon")
    if model is None:
        raise ModelSelectionError(
            "model_unavailable",
            "Запрошенная модель отсутствует среди доступных моделей веб-сессии Google. "
            "Другая модель не подставлена. Каталог: GET /v1/models.",
        )
    return Selection(model.model_name, thinking if override is None else override, router)


def model_catalog(models):
    names = dict(PUBLIC_MODELS)
    for model in selectable_models(models):
        names.setdefault(model.model_name, getattr(model, "display_name", model.model_name))
    available, unavailable = [], []
    for name, label in names.items():
        try:
            selection = select_model(models, name)
        except ModelSelectionError:
            unavailable.append(name)
            continue
        available.append({
            "id": name, "object": "model", "owned_by": "google" if not selection.router else "local",
            "name": label, "available": True, "resolved_model": selection.model,
            "generation_verified": False, "tool_calling": "text_emulation",
        })
    return {
        "object": "list", "known": bool(models),
        "account_models": sorted(m.model_name for m in selectable_models(models)),
        "data": available, "unavailable_models": unavailable,
        "transport": "unofficial_gemini_web", "native_function_calling": False,
    }
