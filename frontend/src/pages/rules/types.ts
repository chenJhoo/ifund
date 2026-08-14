// 规则引擎相关类型：与后端 /api/rules/* 返回结构一一对应（见 backend/app/rules/service.py）

export type RuleType = 'add_1' | 'add_2' | 'add_3' | 'take_profit'

export interface FundRule {
  id: number
  fund_code: string
  fund_name?: string
  rule_type: RuleType
  trigger_pct: number
  trigger_nav: number
  fund_pct: number
  amount: number
  action: string
  note?: string
  executed: number
  executed_date: string | null
  triggered: boolean
}

export interface RuleOverviewItem {
  fund_code: string
  fund_name: string
  sector: string
  fund_type: string
  market_value: number | null
  cost: number | null
  shares: number | null
  cost_price: number | null
  latest_nav: number | null
  nav_date: string | null
  return_pct: number | null // 小数，如 -0.1676
  pnl: number | null
  planned_amount: number
  used_amount: number
  remain_amount: number
  valuation_pct: number | null
  discipline: string
  status: string // 持有观察中 / 触发补仓第N档 / 触发止盈 / 数据缺失
  rules: FundRule[]
  triggered_count: number
  pending_count: number
}

export interface RuleAlert {
  rule_id: number
  fund_code: string
  fund_name: string
  rule_type: RuleType
  rule_label: string
  trigger_nav: number
  latest_nav: number | null
  nav_date: string | null
  amount: number
  action: string
}

/** 补仓3档红色系 + 止盈绿，供表格标签与走势图参考线共用 */
export const RULE_COLORS: Record<RuleType, string> = {
  add_1: '#ffa39e',
  add_2: '#ff4d4f',
  add_3: '#cf1322',
  take_profit: '#389e0d',
}

const TIER_NAME: Record<RuleType, string> = {
  add_1: '补仓①',
  add_2: '补仓②',
  add_3: '补仓③',
  take_profit: '止盈',
}

/** 规则中文标签：补仓① -10% / 止盈 +25% */
export function ruleLabel(r: Pick<FundRule, 'rule_type' | 'trigger_pct'>): string {
  const pct = `${r.trigger_pct > 0 ? '+' : ''}${(r.trigger_pct * 100).toFixed(0)}%`
  return `${TIER_NAME[r.rule_type] ?? r.rule_type} ${pct}`
}

/** 展示顺序：补仓①②③ → 止盈（后端按 trigger_pct 升序返回，档位是反的） */
const RULE_ORDER: Record<RuleType, number> = { add_1: 0, add_2: 1, add_3: 2, take_profit: 3 }

export function sortRules(rules: FundRule[]): FundRule[] {
  return [...rules].sort((a, b) => RULE_ORDER[a.rule_type] - RULE_ORDER[b.rule_type])
}

export function isAddRule(t: RuleType): boolean {
  return t !== 'take_profit'
}
