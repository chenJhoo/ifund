"""规则引擎蓝图：规则总览 / 触发提醒 / 规则 CRUD / 执行登记 / 补仓计划维护。

全部按 user_id 隔离；实盘归属校验复用 reconcile 路由的 ``_resolve_portfolio``。
执行登记联动：写一笔交易（txn_store）+ 规则置为已执行 + fund_plans.used_amount 累加。
"""
from __future__ import annotations

import datetime

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required

from app import db as database
from app import preset_access
from app.reconcile.api.router import _resolve_portfolio
from app.reconcile.crud import txn_store
from app.rules import service

bp = Blueprint("rules", __name__, url_prefix="/api/rules")


def _owned_rule(rule_id: int, uid: int) -> dict | None:
    row = database.select_one("fund_rules", {"id": rule_id})
    if not row or int(row.get("user_id", -1)) != int(uid):
        return None
    return row


@bp.get("/overview")
@jwt_required()
def overview():
    """实盘全部基金的规则触发总览（持仓+计划+4条规则+状态）。"""
    uid = preset_access.current_user_id()
    pf, err = _resolve_portfolio(uid)
    if err:
        return jsonify(err[0]), err[1]
    return jsonify({"items": service.evaluate_portfolio(pf["id"])})


@bp.get("/alerts")
@jwt_required()
def alerts():
    """当前已触发且未执行的规则清单（Dashboard 提醒卡片）。"""
    uid = preset_access.current_user_id()
    pf, err = _resolve_portfolio(uid)
    if err:
        return jsonify(err[0]), err[1]
    return jsonify({"items": service.triggered_alerts(pf["id"])})


@bp.post("")
@jwt_required()
def create_rule():
    """新增一条规则。body: fund_code/rule_type/trigger_pct/trigger_nav/..."""
    uid = preset_access.current_user_id()
    body = request.get_json(silent=True) or {}
    pf, err = _resolve_portfolio(uid)
    if err:
        return jsonify(err[0]), err[1]
    row = database.insert("fund_rules", {
        "portfolio_id": pf["id"], "user_id": uid,
        "fund_code": str(body.get("fund_code", "")).strip(),
        "fund_name": str(body.get("fund_name", "")).strip(),
        "rule_type": body["rule_type"],
        "trigger_pct": float(body["trigger_pct"]),
        "trigger_nav": float(body["trigger_nav"]),
        "fund_pct": float(body.get("fund_pct") or 0),
        "amount": float(body.get("amount") or 0),
        "action": str(body.get("action", "")),
        "note": str(body.get("note", "")),
    })
    return jsonify(row)


@bp.patch("/<int:rule_id>")
@jwt_required()
def update_rule(rule_id: int):
    """编辑规则（触发条件/触发净值/金额/动作/备注/是否执行）。"""
    uid = preset_access.current_user_id()
    if not _owned_rule(rule_id, uid):
        return jsonify({"detail": "rule not found"}), 404
    body = request.get_json(silent=True) or {}
    data = {}
    for key in ("trigger_pct", "trigger_nav", "fund_pct", "amount"):
        if key in body:
            data[key] = float(body[key])
    for key in ("action", "note", "executed_date"):
        if key in body:
            data[key] = str(body[key])
    if "executed" in body:
        data["executed"] = 1 if body["executed"] else 0
    if data:
        database.update("fund_rules", {"id": rule_id}, data)
    return jsonify(database.select_one("fund_rules", {"id": rule_id}))


@bp.delete("/<int:rule_id>")
@jwt_required()
def delete_rule(rule_id: int):
    """删除一条规则。"""
    uid = preset_access.current_user_id()
    if not _owned_rule(rule_id, uid):
        return jsonify({"detail": "rule not found"}), 404
    database.delete("fund_rules", {"id": rule_id})
    return jsonify({"ok": True})


@bp.post("/<int:rule_id>/execute")
@jwt_required()
def execute_rule(rule_id: int):
    """执行登记：写交易 + 规则置已执行 + 累加已用补仓资金。

    body 可选：``trade_date``（默认今天）、``amount``（默认规则触发金额）。
    交易净值由 txn_store 按交易日锁定；买入/卖出由规则类型决定。
    """
    uid = preset_access.current_user_id()
    rule = _owned_rule(rule_id, uid)
    if not rule:
        return jsonify({"detail": "rule not found"}), 404
    body = request.get_json(silent=True) or {}
    trade_date = body.get("trade_date") or datetime.date.today().isoformat()
    amount = float(body.get("amount") or rule["amount"])
    if amount <= 0:
        return jsonify({"detail": "amount must be positive"}), 400

    txn_type = "sell" if rule["rule_type"] == "take_profit" else "buy"
    txn = txn_store.add_txn(rule["portfolio_id"], uid, rule["fund_code"],
                            rule.get("fund_name", ""), txn_type, trade_date, amount,
                            note=f"规则执行·{rule['rule_type']}")
    database.update("fund_rules", {"id": rule_id},
                    {"executed": 1, "executed_date": trade_date})
    if txn_type == "buy":
        plan = database.select_one("fund_plans", {
            "portfolio_id": f"eq.{rule['portfolio_id']}",
            "fund_code": f"eq.{rule['fund_code']}"})
        if plan:
            database.update("fund_plans", {"id": plan["id"]}, {
                "used_amount": round((plan.get("used_amount") or 0) + amount, 2),
                "updated_at": datetime.datetime.now().isoformat()})
    return jsonify({"ok": True, "txn": txn})


@bp.patch("/plans/<fund_code>")
@jwt_required()
def update_plan(fund_code: str):
    """更新补仓计划（计划资金/已用资金/估值百分位/备注）。"""
    uid = preset_access.current_user_id()
    pf, err = _resolve_portfolio(uid)
    if err:
        return jsonify(err[0]), err[1]
    body = request.get_json(silent=True) or {}
    plan = database.select_one("fund_plans", {
        "portfolio_id": f"eq.{pf['id']}", "fund_code": f"eq.{fund_code}"})
    data = {"updated_at": datetime.datetime.now().isoformat()}
    for key in ("planned_amount", "used_amount", "valuation_pct"):
        if key in body:
            data[key] = float(body[key]) if body[key] is not None else None
    for key in ("note", "sector", "fund_type"):
        if key in body:
            data[key] = str(body[key])
    if plan:
        database.update("fund_plans", {"id": plan["id"]}, data)
    else:
        database.insert("fund_plans", {
            "portfolio_id": pf["id"], "user_id": uid, "fund_code": fund_code, **data})
    return jsonify(database.select_one("fund_plans", {
        "portfolio_id": f"eq.{pf['id']}", "fund_code": f"eq.{fund_code}"}))
