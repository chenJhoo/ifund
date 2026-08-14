import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, Card, Col, DatePicker, InputNumber, Modal, Row, Space, Statistic, Table, Tag, Tooltip, message,
} from 'antd'
import { EditOutlined, FundOutlined, LineChartOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import request from '../../api/request'
import { RULE_COLORS, isAddRule, ruleLabel, sortRules } from './types'
import type { FundRule, RuleOverviewItem } from './types'
import RuleTrendModal from './RuleTrendModal'

const UP = '#f5222d'   // 涨红
const DOWN = '#52c41a' // 跌绿

const fmtMoney = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtNav = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(4))

function statusColor(status: string): string {
  if (status === '触发止盈') return 'gold'
  if (status.startsWith('触发补仓')) return 'red'
  if (status === '数据缺失') return 'orange'
  return 'blue'
}

/** 规则看板：持仓 × 补仓/止盈规则触发状态一览，支持执行登记与估值百分位维护。 */
export default function RulesPage() {
  const [items, setItems] = useState<RuleOverviewItem[]>([])
  const [loading, setLoading] = useState(false)
  const [trendFund, setTrendFund] = useState<RuleOverviewItem | null>(null)
  // 执行登记弹窗
  const [execRule, setExecRule] = useState<{ fund: RuleOverviewItem; rule: FundRule } | null>(null)
  const [execAmount, setExecAmount] = useState<number>(0)
  const [execDate, setExecDate] = useState<Dayjs>(dayjs())
  const [executing, setExecuting] = useState(false)
  // 估值百分位行内编辑
  const [editingVal, setEditingVal] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await request.get<{ items: RuleOverviewItem[] }>('/rules/overview')
      setItems(data.items ?? [])
    } catch {
      message.error('加载规则看板失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const summary = useMemo(() => ({
    fundCount: items.length,
    totalMv: items.reduce((s, f) => s + (f.market_value ?? 0), 0),
    totalPnl: items.reduce((s, f) => s + (f.pnl ?? 0), 0),
    pending: items.reduce((s, f) => s + f.pending_count, 0),
  }), [items])

  const openExec = (fund: RuleOverviewItem, rule: FundRule) => {
    setExecRule({ fund, rule })
    setExecAmount(rule.amount)
    setExecDate(dayjs())
  }

  const submitExec = async () => {
    if (!execRule) return
    if (!execAmount || execAmount <= 0) {
      message.warning('请输入有效的执行金额')
      return
    }
    setExecuting(true)
    try {
      await request.post(`/rules/${execRule.rule.id}/execute`, {
        trade_date: execDate.format('YYYY-MM-DD'),
        amount: execAmount,
      })
      message.success('已登记执行：交易已写入，规则标记为已执行')
      setExecRule(null)
      await load()
    } catch {
      message.error('执行登记失败')
    } finally {
      setExecuting(false)
    }
  }

  // 估值百分位：每月手工更新，空值表示清除
  const saveValuation = async (fund: RuleOverviewItem, raw: string) => {
    setEditingVal(null)
    const trimmed = raw.trim()
    const val = trimmed === '' ? null : Number(trimmed)
    if (val !== null && (!Number.isFinite(val) || val < 0 || val > 100)) {
      message.warning('估值百分位应为 0-100 的数字')
      return
    }
    if (val === fund.valuation_pct) return
    try {
      await request.patch(`/rules/plans/${fund.fund_code}`, { valuation_pct: val })
      message.success('估值百分位已更新')
      await load()
    } catch {
      message.error('更新估值百分位失败')
    }
  }

  const columns: ColumnsType<RuleOverviewItem> = [
    {
      title: '基金',
      key: 'fund',
      width: 190,
      render: (_, f) => (
        <div>
          <div style={{ fontWeight: 500 }}>{f.fund_name || '—'}</div>
          <div style={{ color: '#999', fontSize: 12 }}>{f.fund_code}</div>
        </div>
      ),
    },
    { title: '板块', dataIndex: 'sector', width: 120, render: (v: string) => v || '—' },
    {
      title: '成本价',
      dataIndex: 'cost_price',
      width: 90,
      align: 'right',
      render: (v: number | null) => fmtNav(v),
    },
    {
      title: '最新净值',
      key: 'latest_nav',
      width: 120,
      align: 'right',
      render: (_, f) => (
        <div>
          <div>{fmtNav(f.latest_nav)}</div>
          <div style={{ color: '#999', fontSize: 12 }}>{f.nav_date ?? '—'}</div>
        </div>
      ),
    },
    {
      title: '收益率',
      dataIndex: 'return_pct',
      width: 90,
      align: 'right',
      render: (v: number | null) =>
        v == null ? '—' : (
          <span style={{ color: v >= 0 ? UP : DOWN }}>
            {v >= 0 ? '+' : ''}{(v * 100).toFixed(2)}%
          </span>
        ),
    },
    {
      title: '市值',
      dataIndex: 'market_value',
      width: 110,
      align: 'right',
      render: (v: number | null) => fmtMoney(v),
    },
    {
      title: '盈亏',
      dataIndex: 'pnl',
      width: 100,
      align: 'right',
      render: (v: number | null) =>
        v == null ? '—' : (
          <span style={{ color: v >= 0 ? UP : DOWN }}>
            {v >= 0 ? '+' : ''}{fmtMoney(v)}
          </span>
        ),
    },
    {
      title: '剩余补仓资金',
      key: 'remain',
      width: 130,
      align: 'right',
      render: (_, f) => (
        <Tooltip title={`计划 ${fmtMoney(f.planned_amount)} · 已用 ${fmtMoney(f.used_amount)}`}>
          <span>
            {fmtMoney(f.remain_amount)}
            <span style={{ color: '#999', fontSize: 12 }}> / {fmtMoney(f.planned_amount)}</span>
          </span>
        </Tooltip>
      ),
    },
    {
      title: '估值百分位',
      key: 'valuation',
      width: 130,
      align: 'right',
      render: (_, f) =>
        editingVal === f.fund_code ? (
          <InputNumber
            size="small"
            autoFocus
            min={0}
            max={100}
            precision={1}
            defaultValue={f.valuation_pct ?? undefined}
            style={{ width: 84 }}
            placeholder="0-100"
            onBlur={(e) => saveValuation(f, e.target.value)}
            onPressEnter={(e) => saveValuation(f, (e.target as HTMLInputElement).value)}
          />
        ) : (
          <Tooltip title={f.discipline || '点击填写估值百分位（每月手工更新）'}>
            <span style={{ cursor: 'pointer' }} onClick={() => setEditingVal(f.fund_code)}>
              {f.valuation_pct != null ? `${f.valuation_pct}%` : <span style={{ color: '#bbb' }}>未填</span>}
              <EditOutlined style={{ marginLeft: 4, color: '#bbb', fontSize: 12 }} />
              {f.discipline && (
                <div style={{ color: '#999', fontSize: 12 }}>{f.discipline}</div>
              )}
            </span>
          </Tooltip>
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 130,
      render: (v: string, f) => (
        <Space size={4} wrap>
          <Tag color={statusColor(v)}>{v}</Tag>
          {f.pending_count > 0 && <Tag color="red">待执行 {f.pending_count}</Tag>}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 80,
      render: (_, f) => (
        <Button size="small" type="link" icon={<LineChartOutlined />} onClick={() => setTrendFund(f)}>
          走势
        </Button>
      ),
    },
  ]

  const ruleColumns: ColumnsType<{ fund: RuleOverviewItem; rule: FundRule }> = [
    {
      title: '规则',
      key: 'label',
      width: 130,
      render: (_, { rule }) => (
        <Tag color={RULE_COLORS[rule.rule_type]} style={{ color: '#fff' }}>
          {ruleLabel(rule)}
        </Tag>
      ),
    },
    {
      title: '触发净值',
      key: 'trigger_nav',
      width: 100,
      align: 'right',
      render: (_, { rule }) => rule.trigger_nav.toFixed(4),
    },
    {
      title: '触发金额',
      key: 'amount',
      width: 110,
      align: 'right',
      render: (_, { rule }) => fmtMoney(rule.amount),
    },
    { title: '动作', key: 'action', render: (_, { rule }) => rule.action || '—' },
    {
      title: '是否触发',
      key: 'triggered',
      width: 90,
      render: (_, { rule }) =>
        rule.triggered ? <Tag color="red">已触发</Tag> : <Tag>未触发</Tag>,
    },
    {
      title: '执行状态',
      key: 'executed',
      width: 200,
      render: (_, { fund, rule }) =>
        rule.executed ? (
          <Tag color="green">已执行{rule.executed_date ? ` · ${rule.executed_date}` : ''}</Tag>
        ) : rule.triggered ? (
          <Button size="small" type="primary" danger={isAddRule(rule.rule_type)} onClick={() => openExec(fund, rule)}>
            执行
          </Button>
        ) : (
          <span style={{ color: '#bbb' }}>—</span>
        ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Row gutter={16}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="持仓基金数" value={summary.fundCount} suffix="只" prefix={<FundOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="总市值" value={summary.totalMv} precision={2} prefix="¥" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="总浮动盈亏"
              value={summary.totalPnl}
              precision={2}
              prefix={summary.totalPnl >= 0 ? '+¥' : '-¥'}
              valueStyle={{ color: summary.totalPnl >= 0 ? UP : DOWN }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="已触发待执行规则"
              value={summary.pending}
              suffix="条"
              valueStyle={{ color: summary.pending > 0 ? UP : undefined }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title="规则看板"
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
        }
      >
        <Table<RuleOverviewItem>
          rowKey="fund_code"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={items}
          pagination={false}
          scroll={{ x: 1180 }}
          expandable={{
            expandedRowRender: (f) => (
              <Table
                rowKey={(r) => r.rule.id}
                size="small"
                pagination={false}
                columns={ruleColumns}
                dataSource={sortRules(f.rules).map((rule) => ({ fund: f, rule }))}
              />
            ),
            rowExpandable: (f) => f.rules.length > 0,
          }}
        />
      </Card>

      <RuleTrendModal fund={trendFund} open={trendFund !== null} onClose={() => setTrendFund(null)} />

      <Modal
        open={execRule !== null}
        title={execRule ? `执行登记 · ${execRule.fund.fund_name}（${execRule.fund.fund_code}）` : ''}
        onOk={submitExec}
        onCancel={() => setExecRule(null)}
        okText="确认执行"
        cancelText="取消"
        confirmLoading={executing}
        destroyOnClose
      >
        {execRule && (
          <Space direction="vertical" size="middle" style={{ width: '100%', marginTop: 8 }}>
            <div>
              <Tag color={RULE_COLORS[execRule.rule.rule_type]} style={{ color: '#fff' }}>
                {ruleLabel(execRule.rule)}
              </Tag>
              <span>{execRule.rule.action}</span>
            </div>
            <div style={{ color: '#666', fontSize: 13 }}>
              触发净值 {execRule.rule.trigger_nav.toFixed(4)} · 最新净值 {fmtNav(execRule.fund.latest_nav)}
              {execRule.fund.nav_date ? `（${execRule.fund.nav_date}）` : ''}
            </div>
            <div>
              执行金额：
              <InputNumber
                min={0.01}
                precision={2}
                value={execAmount}
                onChange={(v) => setExecAmount(v ?? 0)}
                style={{ width: 160, marginLeft: 8 }}
                prefix="¥"
              />
            </div>
            <div>
              交易日期：
              <DatePicker
                value={execDate}
                onChange={(d) => d && setExecDate(d)}
                allowClear={false}
                style={{ marginLeft: 8 }}
              />
            </div>
            <div style={{ color: '#999', fontSize: 12 }}>
              确认后将写入一笔{execRule.rule.rule_type === 'take_profit' ? '卖出' : '买入'}交易，
              规则标记为已执行{isAddRule(execRule.rule.rule_type) ? '，并扣减剩余补仓资金' : ''}。
            </div>
          </Space>
        )}
      </Modal>
    </div>
  )
}
