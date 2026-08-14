# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Build / Lint / Test

```bash
# Dev (backend :8000 hot-reload + frontend :9000 HMR)
./start.sh

# Backend lint — MUST stay 10.00/10; disable=[] in pyproject.toml, suppress inline only
./backend/venv/bin/pylint app

# Frontend
cd frontend && npx tsc --noEmit   # type check
cd frontend && npm run lint       # eslint
```

Pylint max line length is **120** chars. `pyproject.toml` has relaxed design limits (max-args=10, max-locals=30, max-statements=80, max-branches=20) — don't refactor to satisfy defaults.

## Code Style

- **All backend Python files** must start with `from __future__ import annotations`.
- **Exception**: `mcp_server/server.py` — deliberately omits it because FastMCP reads type annotations as runtime objects; stringified annotations break tool registration.
- No ORM at runtime. `flask-sqlalchemy` is installed but only used for model declarations as documentation. All data access uses raw SQL via the abstraction layer in `backend/app/db/` (`Database` ABC in `base.py`, SQLite impl in `sqlite.py`).
- All `akshare` calls MUST run in a **subprocess worker** (`backend/app/common/worker_base.py`). Calling akshare inside a Flask request thread crashes the server (socket fd conflict).

## Architecture Gotchas

- **Flask 3.1**, not FastAPI (some older docs still say FastAPI — ignore). App factory pattern in `backend/app/main.py`, routes as Blueprints under each module's `api/router.py`.
- **SQLite only** for now. MySQL is planned but unimplemented. The DB abstraction layer (`backend/app/db/base.py`) is the contract — new backends implement the `Database` ABC without touching business code.
- **Frontend dev :9000 proxies `/api` → backend :8000**. Production build outputs to `backend/static`; backend serves the SPA on :8000 directly (no separate frontend server needed in prod).
- **`./service.sh` (launchd+waitress) and `./start.sh` share port :8000** — they cannot run simultaneously. Stop the service before debugging: `./service.sh stop` → `./start.sh` → Ctrl-C → `./service.sh start`.
- **MCP server** (`mcp_server/server.py`) shares `backend/venv`. Slimmed (2026-06) to a **single `ifund(args)` passthrough tool** that execs `backend/ifund_cli.py` — no HTTP/PAT/JWT. It's only a thin bridge for MCP-only agents (e.g. OpenClaw); shell-capable agents should call the CLI directly (see below). Old 33-tool impl in `server.py.33tools.bak`.

## Data CLI (查询/分析 iFund 数据的首选)

需要 iFund 数据（预设/镜像、仓位建议、实盘持仓与穿透、组合表现）或拉取数据时，**优先用
`backend/ifund_cli.py`**，不要打 HTTP API、也不要直接读 `data.db` 原始表。它直连本机
`data.db`、复用后端 crud/算法层（无需后端服务/登录），输出紧凑、可加 `--json` 解析。

```bash
cd /Users/huangcheng/Desktop/ifund/backend
./venv/bin/python3 ifund_cli.py <组> <命令> [--json] [-h]   # 任意命令加 -h 自查参数
```

- `preset  list | show --id N | snapshot --id N | funds --id N [--code C][--keyword K][--ai] | ai-set --code N --data '{...}'`（snapshot=按预设条件重建镜像；funds=查预设镜像内基金+基础信息，--ai 附 AI 定性分析列；ai-set=写入基金 AI 分析，OpenClaw 填充，部分 upsert）
- `fetch   calendar | industry --mode sw|em | detail|holdings|nav [--codes ..] [--types ..]`（联网慢，自带缓存）
- `analyze  run --preset N [--balance 松|中|紧 | --cap 0.10~0.30] [--view weights|industry|stock|perf|all]`（组合分析：必选预设→仓位建议→穿透/赛道/分区间表现）
- `holdings list | show --pid N（实际持仓按赛道簇分组，加 --penetration 附底层穿透）| penetration | perf | rebalance --pid N [--sell-outside] [--no-trim-overflow] [--band B]（调仓建议操作指南）`
- `holdings buy|sell --pid N --fund 代码/名称 --amount A | transfer --from .. --to .. --amount A | txns --pid N | txn-del --pid N --id T`（实盘交易；持仓录入在网页端）

实现拆在 `backend/cli/` 包（薄壳 `ifund_cli.py` 等价于 `python -m cli`）。命令树即文档：`-h`
按需查，无预载成本。**这是替代旧 MCP 多工具的省 Token 方案**——优先 CLI。

## Repo Conventions

- Commit messages in **Chinese**, conventional prefix: `feat:`, `fix:`, `docs:`, `refactor:`.
- Single `main` branch; no PR workflow in place.
- `backend/.env` is gitignored — copy from `backend/.env.example` if present.

## 二开：基金规则引擎（chenJhoo fork，2026-08）

在上游底座上叠加了"持仓规则平台"能力：从 `基金持仓规则表.xlsx` 导入真实持仓，按
补仓3档金字塔（-10%/-20%/-30%）+ 止盈（+25%）规则做触发判定、可视化和每日提醒。

### 数据流

```
基金持仓规则表.xlsx
  └─ cli/import_xlsx.py（ifund import-xlsx run，一次性导入，--reset 可重建）
       ├─ holding_txns   每只基金一笔建仓 buy（amount=成本价×份额, nav=成本价, shares=份额）
       ├─ fund_plans     计划/已用补仓资金、板块、类型、估值百分位（新表）
       └─ fund_rules     44 条规则（新表，UNIQUE(portfolio_id, fund_code, rule_type)）
holdings_compute（上游）合成持仓 → rules/service.py 评估 → /api/rules/* → 前端 pages/rules/
```

### 规则引擎口径（与 Excel 一致，改逻辑先同步 tests/test_rules.py）

- 持仓收益率 = 最新净值 ÷ (合成成本 ÷ 合成份额) − 1（移动平均成本）。
- 补仓档触发：净值 **≤** 触发净值；止盈：净值 **≥** 触发净值（边界取等）。
- 状态取**最深**触发档（如 -42% → 触发补仓第3档）；止盈与补仓天然互斥，止盈优先展示。
- `executed=1` 的规则不再进 alerts；执行登记（POST `/api/rules/<id>/execute`）联动：
  写一笔 buy/sell 交易 + 置已执行 + `fund_plans.used_amount` 累加（仅补仓）。
- 估值百分位（fund_plans.valuation_pct）每月手工更新，只影响纪律提示，不参与触发判定。

### 新增文件

- 后端：`app/rules/`（`service.py` 评估 + `api/router.py` 蓝图，挂在 `/api/rules`）、
  `cli/import_xlsx.py`、`cli/rules.py`（overview/alerts/daily）、`tests/test_rules.py`
  （`./venv/bin/python -m unittest tests.test_rules`）。
- 表：`fund_rules`、`fund_plans`（追加在 `schema_sqlite.sql` 末尾，启动幂等建表）。
- 前端：`pages/rules/`（RulesPage 看板 / RuleTrendModal 净值走势+触发线 / RuleAlertsCard
  首页提醒卡）；Dashboard 注册 `/rules` 菜单，FundPage 首页挂 RuleAlertsCard。
- 运维：`daily.sh`（launchd `com.ifund.daily-rules`，每日 21:35 拉净值+评估+macOS 通知）。

### 运维与坑

- 常驻服务标签是 **`com.ifund.server`**（不是上游默认的 com.ifund.backend）：macOS TCC
  会把"桌面文件夹访问拒绝"缓存在 launchd 标签上，一旦被拒过，同标签永远 EPERM，换标签即解。
- `app/db` 抽象层**参数风格不一致**：`select/select_one` 用 `eq.xxx` 前缀（也兼容裸值），
  而 `update/delete` 的 filters 是**裸值等值**（传 `eq.1` 会静默不匹配）。新代码注意。
- 天天基金盘中估值接口（fundgz / akshare fund_value_estimation_em / fundmobapi）已随监管
  全部下线，盘中估算功能当前为**每日净值降级模式**；要恢复只能按基金配跟踪指数近似。
- akshare 必须在子进程 worker 里跑（上游约束）；`cli/rules.py daily` 里直接调
  `fund_nav.fetch.worker._process_one` 是 CLI 直连场景，安全。
- 验证清单：`./backend/venv/bin/pylint app`（≥上游基线即可）、`cd frontend && npx tsc --noEmit
  && npm run build`、后端改完 `./service.sh restart`（waitress 无热重载）。
