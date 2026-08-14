"""规则评估服务单测：触发边界 / 最深档判定 / 止盈优先 / 净值缺失退化。

运行：``./venv/bin/python -m unittest tests.test_rules -v``（backend 目录下）。
用临时 SQLite 库，不碰真实 data.db。
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DB_PATH"] = _tmp.name  # 须在 import app 之前

from app import db as database  # noqa: E402
from app.rules import service  # noqa: E402

_SCHEMA = (Path(__file__).resolve().parents[1] / "schema_sqlite.sql").read_text(encoding="utf-8")

PID = 1
ADD_PCTS = {"add_1": -0.10, "add_2": -0.20, "add_3": -0.30}


def _seed_fund(code: str, cost_price: float, shares: float, latest_nav: float | None):
    """造一只基金：建仓交易（成本）+ 计划 + 4 条规则 + 可选最新净值。"""
    database.insert("holding_txns", {
        "portfolio_id": PID, "user_id": 1, "fund_code": code, "fund_name": f"基金{code}",
        "txn_type": "buy", "trade_date": "2026-01-01",
        "amount": cost_price * shares, "nav": cost_price, "shares": shares, "note": "test",
    })
    database.insert("fund_plans", {
        "portfolio_id": PID, "user_id": 1, "fund_code": code,
        "planned_amount": 1000, "used_amount": 0,
    })
    for rtype, pct in {**ADD_PCTS, "take_profit": 0.25}.items():
        database.insert("fund_rules", {
            "portfolio_id": PID, "user_id": 1, "fund_code": code,
            "fund_name": f"基金{code}", "rule_type": rtype,
            "trigger_pct": pct, "trigger_nav": round(cost_price * (1 + pct), 6),
            "fund_pct": 0.3, "amount": 300, "action": "test",
        })
    if latest_nav is not None:
        database.insert("fund_nav", {
            "fund_code": code, "trade_date": "2026-08-10", "nav": latest_nav,
        })


class TestEvaluate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        database.init_db(_SCHEMA)
        database.insert("users", {"id": 1, "username": "t", "hashed_password": "x"})
        database.insert("portfolios", {"id": PID, "user_id": 1, "name": "测试"})
        # 净值恰好在第3档触发线上（-30%）→ 触发补仓第3档（边界取等）
        _seed_fund("A00001", 1.0, 100, 0.70)
        # 深度跌破（-43%）→ 最深档：触发补仓第3档
        _seed_fund("A00002", 1.0, 100, 0.57)
        # 恰在第1档线之上一点点 → 持有观察中
        _seed_fund("A00003", 1.0, 100, 0.9001)
        # 恰好 +25% → 触发止盈（边界取等）
        _seed_fund("A00004", 1.0, 100, 1.25)
        # 无净值 → 数据缺失
        _seed_fund("A00005", 1.0, 100, None)

    def _fund(self, code: str) -> dict:
        items = service.evaluate_portfolio(PID)
        return next(f for f in items if f["fund_code"] == code)

    def test_boundary_add_tier3(self):
        f = self._fund("A00001")
        self.assertEqual(f["status"], "触发补仓第3档")
        self.assertEqual(f["triggered_count"], 3)

    def test_deepest_tier(self):
        f = self._fund("A00002")
        self.assertEqual(f["status"], "触发补仓第3档")

    def test_observing(self):
        f = self._fund("A00003")
        self.assertEqual(f["status"], "持有观察中")
        self.assertEqual(f["triggered_count"], 0)

    def test_take_profit_boundary(self):
        f = self._fund("A00004")
        self.assertEqual(f["status"], "触发止盈")
        hit = [r["rule_type"] for r in f["rules"] if r["triggered"]]
        self.assertEqual(hit, ["take_profit"])

    def test_missing_nav(self):
        f = self._fund("A00005")
        self.assertEqual(f["status"], "数据缺失")

    def test_alerts_only_unexecuted(self):
        database.update("fund_rules",
                        {"portfolio_id": PID, "fund_code": "A00001"},
                        {"executed": 1})
        alerts = service.triggered_alerts(PID)
        codes = {a["fund_code"] for a in alerts}
        self.assertNotIn("A00001", codes)
        self.assertIn("A00002", codes)
        self.assertIn("A00004", codes)

    def test_discipline_label(self):
        self.assertEqual(service.discipline_label(None), "")
        self.assertIn("低估", service.discipline_label(20))
        self.assertIn("合理", service.discipline_label(50))
        self.assertIn("偏高", service.discipline_label(75))
        self.assertIn("高估", service.discipline_label(90))


if __name__ == "__main__":
    unittest.main()
