"""规则评估服务：最新净值 × 成本价 × 规则档位 → 每只基金的触发状态。

口径与「基金持仓规则表.xlsx」一致：
- 持仓收益率 = 最新净值 ÷ 成本价 − 1（成本价 = 合成成本 ÷ 合成份额，移动平均成本）。
- 补仓档触发：最新净值 ≤ 触发净值（收益率 ≤ -10%/-20%/-30%）；止盈触发：≥ +25%。
- 状态取最深触发档：多只档位同时跌破时显示最深一档（如 -43% → 触发补仓第3档）；
  触发止盈优先展示（浮盈状态下补仓档不可能同时触发，二者天然互斥）。
- 估值百分位纪律（每月手工更新 fund_plans.valuation_pct）：
  <30 低估区（可正常补仓）/ 30-70 合理区（严格按档位）/ 70-80 偏高区（停止新增买入）/
  >80 高估区（暂停一切补仓）。
"""
from __future__ import annotations

from app import db as database
from app.reconcile.crud import holdings_compute

ADD_TIERS = ("add_1", "add_2", "add_3")          # 深度递增
TIER_LABEL = {"add_1": "补仓第1档", "add_2": "补仓第2档",
              "add_3": "补仓第3档", "take_profit": "止盈"}


def discipline_label(valuation_pct) -> str:
    """板块估值百分位 → 纪律文案；未填返回空串。"""
    if valuation_pct is None:
        return ""
    v = float(valuation_pct)
    if v < 30:
        return "低估区·可正常补仓"
    if v <= 70:
        return "合理区·严格按档位执行"
    if v <= 80:
        return "偏高区·停止新增买入"
    return "高估区·暂停补仓，反弹分批止盈"


def evaluate_portfolio(pid: int) -> list[dict]:
    """评估某实盘全部持仓基金的规则触发状态，按市值降序返回。

    每只基金输出：持仓（市值/成本/份额/最新净值/净值日期/收益率）、
    补仓计划（计划/已用/剩余、板块、估值纪律）、4 条规则（含是否触发/是否执行）、
    汇总状态（持有观察中 / 触发补仓第N档 / 触发止盈 / 数据缺失）。
    """
    holdings = {h["fund_code"]: h for h in holdings_compute.compute_holdings(pid)}
    plans = {p["fund_code"]: p for p in
             database.select("fund_plans", {"portfolio_id": f"eq.{pid}"})}
    rules_by_code: dict[str, list[dict]] = {}
    for r in database.select("fund_rules", {"portfolio_id": f"eq.{pid}"}):
        rules_by_code.setdefault(r["fund_code"], []).append(r)

    out = []
    for code, h in holdings.items():
        plan = plans.get(code, {})
        rules = rules_by_code.get(code, [])
        cost_price = (h["cost"] / h["shares"]) if h.get("shares") and h.get("cost") else None
        nav = h.get("latest_nav")
        return_pct = (nav / cost_price - 1) if (nav and cost_price) else None

        rule_items = []
        triggered: list[dict] = []
        for r in sorted(rules, key=lambda x: x["trigger_pct"]):
            hit = None
            if nav is not None:
                if r["rule_type"] == "take_profit":
                    hit = nav >= r["trigger_nav"]
                else:
                    hit = nav <= r["trigger_nav"]
            item = {**r, "triggered": bool(hit)}
            rule_items.append(item)
            if hit:
                triggered.append(item)

        status = "数据缺失"
        if nav is not None:
            status = "持有观察中"
            tp = next((r for r in triggered if r["rule_type"] == "take_profit"), None)
            adds = [r for r in triggered if r["rule_type"] in ADD_TIERS]
            if tp:
                status = "触发止盈"
            elif adds:
                status = "触发" + TIER_LABEL[adds[0]["rule_type"]]  # 按 pct 升序，最深档在首位

        out.append({
            "fund_code": code, "fund_name": h.get("fund_name") or "",
            "market_value": h.get("market_value"), "cost": h.get("cost"),
            "shares": h.get("shares"), "cost_price": round(cost_price, 4) if cost_price else None,
            "latest_nav": nav, "nav_date": h.get("nav_date"),
            "return_pct": round(return_pct, 6) if return_pct is not None else None,
            "pnl": h.get("pnl"),
            "planned_amount": plan.get("planned_amount", 0),
            "used_amount": plan.get("used_amount", 0),
            "remain_amount": round(plan.get("planned_amount", 0) - plan.get("used_amount", 0), 2),
            "sector": plan.get("sector", ""), "fund_type": plan.get("fund_type", ""),
            "valuation_pct": plan.get("valuation_pct"),
            "discipline": discipline_label(plan.get("valuation_pct")),
            "status": status,
            "rules": rule_items,
            "triggered_count": len(triggered),
            "pending_count": sum(1 for r in triggered if not r["executed"]),
        })
    out.sort(key=lambda x: x.get("market_value") or 0, reverse=True)
    return out


def triggered_alerts(pid: int) -> list[dict]:
    """当前已触发且未执行的规则清单（Dashboard 提醒用）。"""
    alerts = []
    for fund in evaluate_portfolio(pid):
        for r in fund["rules"]:
            if r["triggered"] and not r["executed"]:
                alerts.append({
                    "rule_id": r["id"], "fund_code": fund["fund_code"],
                    "fund_name": fund["fund_name"], "rule_type": r["rule_type"],
                    "rule_label": TIER_LABEL[r["rule_type"]],
                    "trigger_nav": r["trigger_nav"], "latest_nav": fund["latest_nav"],
                    "nav_date": fund["nav_date"], "amount": r["amount"],
                    "action": r["action"],
                })
    return alerts
