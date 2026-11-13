#!/usr/bin/env python3
"""
Quick CLI Quota Checker for Gemini Web Bridge (Google AI Pro).
Fetches live quota from local bridge server or directly from Google AI Pro session.
"""

import sys
import json
import urllib.request
from datetime import datetime

def check_local_bridge():
    url = "http://127.0.0.1:8010/v1/quota"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "QuotaCLI/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return data
    except Exception:
        return None

def format_time_diff(iso_str):
    if not iso_str:
        return "—"
    try:
        dt = datetime.fromisoformat(iso_str)
        now = datetime.now(dt.tzinfo)
        diff = dt - now
        total_seconds = int(diff.total_seconds())
        if total_seconds <= 0:
            return "прямо сейчас"
        hours = total_seconds // 3600
        mins = (total_seconds % 3600) // 60
        return f"{hours} ч {mins} мин"
    except Exception:
        return iso_str

def main():
    print("=" * 65)
    print("      💎 Gemini Web Bridge · Монитор лимитов Google AI Pro")
    print("=" * 65)

    data = check_local_bridge()
    if not data:
        print("[WARN] Локальный сервер моста не запущен на http://127.0.0.1:8010.")
        print("Запустите start.cmd или start-hidden.vbs в папке gemini-bridge.\n")
        sys.exit(1)

    h5 = data.get("window_5h", {})
    w = data.get("weekly", {})
    est = h5.get("estimated_requests", {})

    h5_rem = h5.get("remaining_credits", 0)
    h5_tot = h5.get("total_credits", 2400)
    h5_pct = h5.get("remaining_percentage", 0)

    w_rem = w.get("remaining_credits", 0)
    w_tot = w.get("total_credits", 48384)
    w_pct = w.get("remaining_percentage", 0)

    print(f"\n📊 СТАТУС ПОДПИСКИ: {data.get('tier', 'PRO')} (Статус аккаунта: {data.get('account_status', 'AVAILABLE')})")
    print("-" * 65)

    print("\n⚡ 5-ЧАСОВОЕ СКОЛЬЗЯЩЕЕ ОКНО (Rolling 5-Hour Window):")
    print(f"  Доступно кредитов:  {h5_rem:,} / {h5_tot:,} ({h5_pct}% доступно)")
    print(f"  Использовано:       {h5.get('used_credits', 0):,} ({h5.get('usage_percentage', 0)}%)")
    print(f"  Сброс лимита:       {h5.get('reset_at', '—')} (через {format_time_diff(h5.get('reset_at'))})")
    print("  Оценка доступных запросов:")
    print(f"    • Hydrogen (быстрые правки кода, 1-2 кр.):     ~{est.get('hydrogen_fast', 0):,} запросов")
    print(f"    • Orchestrator (баланс Carbon+Hydrogen):      ~{est.get('orchestrator_balanced', 0):,} задач")
    print(f"    • Carbon (глубокий Thinking):                 ~{est.get('carbon_deep_thinking', 0):,} рассуждений")

    print("\n📅 НЕДЕЛЬНЫЙ ПУЛ КРЕДИТОВ (Weekly Quota):")
    print(f"  Доступно кредитов:  {w_rem:,} / {w_tot:,} ({w_pct}% доступно)")
    print(f"  Использовано:       {w.get('used_credits', 0):,} ({w.get('usage_percentage', 0)}%)")
    print(f"  Сброс недели:       {w.get('reset_at', '—')} (через {format_time_diff(w.get('reset_at'))})")

    print("\n🧠 АКТИВНЫЙ РЕЖИМ:")
    print("  • Модель по умолчанию: gemini-orchestrator (автомаршрутизация)")
    print("  • Инструментальные ходы: Hydrogen без Thinking (быстрый отклик)")
    print("  • Глубокий анализ:      Carbon + Thinking")
    print("  • Доступные модели:   gemini-orchestrator, gemini-carbon, gemini-pro,")
    print("                        gemini-4-hydrogen-high, gemini-4-hydrogen, gemini-flash-lite")
    print("\n🌐 ВЕБ-ДАШБОРД: http://127.0.0.1:8010/dashboard")
    print("=" * 65)

if __name__ == "__main__":
    main()
