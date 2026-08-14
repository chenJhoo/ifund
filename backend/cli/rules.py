"""CLI: 规则引擎 —— 总览 / 触发提醒 / 每日刷新（净值拉取 + 评估 + macOS 通知）。

用法：
    ifund rules overview          # 打印全部持仓基金规则状态表
    ifund rules alerts            # 打印已触发未执行规则
    ifund rules daily             # 每日任务：拉净值 → 评估 → 有触发则 macOS 通知
"""
from __future__ import annotations

import json
import subprocess
import sys


def _portfolio_id(args) -> int:
    from app import db as database
    rows = database.select("portfolios", {"user_id": f"eq.{args.user}",
                                          "order": "id.asc", "limit": 1})
    if not rows:
        print("错误：当前用户没有实盘", file=sys.stderr)
        sys.exit(1)
    return rows[0]["id"]


def cmd_overview(args) -> None:
    """打印实盘全部基金的规则触发状态。"""
    from app.rules import service
    items = service.evaluate_portfolio(_portfolio_id(args))
    if args.json:
        print(json.dumps(items, ensure_ascii=False))
        return
    print(f"{'代码':<8}{'名称':<14}{'最新净值':>8}{'收益率':>9}  {'状态':<12}净值日期")
    for f in items:
        rp = f"{f['return_pct'] * 100:.2f}%" if f["return_pct"] is not None else "-"
        nav = f"{f['latest_nav']:.4f}" if f["latest_nav"] is not None else "-"
        print(f"{f['fund_code']:<8}{(f['fund_name'] or '')[:6]:<14}{nav:>8}{rp:>9}  "
              f"{f['status']:<12}{f['nav_date'] or '-'}")


def cmd_alerts(args) -> None:
    """打印已触发且未执行的规则。"""
    from app.rules import service
    alerts = service.triggered_alerts(_portfolio_id(args))
    if args.json:
        print(json.dumps(alerts, ensure_ascii=False))
        return
    if not alerts:
        print("当前无已触发待执行的规则")
        return
    for a in alerts:
        print(f"[{a['rule_label']}] {a['fund_code']} {a['fund_name']} "
              f"最新净值 {a['latest_nav']}（{a['nav_date']}）触发线 {a['trigger_nav']} "
              f"→ {a['action']}（约 {a['amount']:.0f} 元）")


def cmd_daily(args) -> None:
    """每日刷新：拉取实盘全部基金最新净值，评估规则，有触发则发 macOS 通知。

    由 launchd 每个交易日 21:35 调用（此时当日净值已公布）。非交易日净值无新增，
    评估结果与前一交易日相同，不会产生新通知之外的副作用。
    """
    from app import db as database
    from app.fund_nav.fetch.worker import _process_one
    from app.rules import service

    pid = _portfolio_id(args)
    codes = sorted({r["fund_code"] for r in
                    database.select("fund_rules", {"portfolio_id": f"eq.{pid}"})})
    print(f"拉取 {len(codes)} 只基金最新净值 ...", flush=True)
    ok = fail = 0
    for code in codes:
        try:
            _process_one(code)
            ok += 1
        except Exception as exc:  # noqa: BLE001 单基金失败不阻断整体
            print(f"  {code} 拉取失败: {exc}", file=sys.stderr)
            fail += 1
    print(f"净值拉取完成：成功 {ok} 失败 {fail}")

    alerts = service.triggered_alerts(pid)
    if not alerts:
        print("评估完成：无已触发待执行规则")
        return
    lines = [f"{a['fund_name']} {a['rule_label']}（约{a['amount']:.0f}元）" for a in alerts]
    msg = f"{len(alerts)} 条规则已触发待执行：" + "；".join(lines[:5])
    print(msg)
    try:
        subprocess.run(["osascript", "-e",
                        f'display notification "{msg}" with title "iFund 规则触发提醒"'],
                       check=False, capture_output=True)
    except FileNotFoundError:
        pass  # 非 macOS 环境静默跳过
