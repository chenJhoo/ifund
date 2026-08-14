import { useEffect, useMemo, useState } from 'react'
import { Alert, Empty, Modal, Segmented, Space, Spin, Statistic, Tag, theme } from 'antd'
import dayjs from 'dayjs'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import request from '../../api/request'
import { RULE_COLORS, ruleLabel, sortRules } from './types'
import type { RuleOverviewItem } from './types'

interface NavPoint {
  date: string
  nav: number
}

interface Props {
  fund: RuleOverviewItem | null
  open: boolean
  onClose: () => void
}

const RANGES = [
  { label: '近3月', value: 3 },
  { label: '近6月', value: 6 },
  { label: '近1年', value: 12 },
  { label: '近3年', value: 36 },
  { label: '全部', value: 0 },
]

const UP = '#f5222d'   // 涨红
const DOWN = '#52c41a' // 跌绿
const COST = '#1677ff' // 成本价实线

/**
 * 规则看板专用净值走势：在历史净值曲线上叠加成本价实线与 4 条规则触发净值虚线，
 * 直观看到当前净值相对各档位的位置。QDII 基金提示净值日期滞后。
 */
export default function RuleTrendModal({ fund, open, onClose }: Props) {
  const { token } = theme.useToken()
  const [data, setData] = useState<NavPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [range, setRange] = useState(12)
  const [active, setActive] = useState<NavPoint | null>(null)

  const code = fund?.fund_code ?? null
  const isQdii = (fund?.fund_type ?? '').includes('QDII')

  useEffect(() => {
    if (!open || !code) return
    setLoading(true)
    setActive(null)
    request
      .get<{ items: NavPoint[] }>(`/fund/${code}/nav`, { params: { limit: 800 } })
      .then(({ data: d }) => setData(d.items ?? []))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [open, code])

  const sliced = useMemo(() => {
    const series = data.filter((p) => Number.isFinite(p.nav))
    if (!range || series.length === 0) return series
    const cutoff = dayjs(series[series.length - 1].date).subtract(range, 'month')
    const win = series.filter((p) => !dayjs(p.date).isBefore(cutoff))
    return win.length >= 2 ? win : series
  }, [data, range])

  const first = sliced[0]?.nav ?? 0
  const last = sliced[sliced.length - 1]?.nav ?? 0
  const lineColor = last >= first ? UP : DOWN

  const shown = active ?? sliced[sliced.length - 1] ?? null
  const shownPct = shown && first ? ((shown.nav - first) / first) * 100 : 0

  const fmtTick = (d: string) => `${d.slice(2, 4)}/${d.slice(5, 7)}`
  const tickGap = Math.max(1, Math.floor(sliced.length / 8))
  const axisTick = { fontSize: 11, fill: token.colorTextTertiary }

  const rules = sortRules(fund?.rules ?? [])
  const costPrice = fund?.cost_price ?? null

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
      title={
        <Space size="small">
          <span>{fund?.fund_name ?? ''}（{code ?? ''}）净值走势</span>
          {fund?.status && <Tag color={statusColor(fund.status)}>{fund.status}</Tag>}
        </Space>
      }
      destroyOnClose
    >
      {isQdii && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          message="QDII 基金净值日期滞后 1-2 个交易日属正常"
        />
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 24 }}>
          <Statistic
            title={shown ? `净值 · ${shown.date}` : '净值'}
            value={shown ? shown.nav : 0}
            precision={4}
            valueStyle={{ fontSize: 22 }}
          />
          <Statistic
            title="较区间首日"
            value={shownPct}
            precision={2}
            suffix="%"
            prefix={shownPct >= 0 ? '+' : ''}
            valueStyle={{ fontSize: 22, color: shownPct >= 0 ? UP : DOWN }}
          />
          {costPrice != null && fund?.latest_nav != null && (
            <Statistic
              title={`持仓收益（成本 ${costPrice.toFixed(4)}）`}
              value={(fund.latest_nav / costPrice - 1) * 100}
              precision={2}
              suffix="%"
              prefix={fund.latest_nav >= costPrice ? '+' : ''}
              valueStyle={{ fontSize: 22, color: fund.latest_nav >= costPrice ? UP : DOWN }}
            />
          )}
        </div>
        <Segmented size="small" options={RANGES} value={range} onChange={(v) => setRange(v as number)} />
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin tip="加载净值中…" />
        </div>
      ) : sliced.length < 2 ? (
        <Empty description="暂无净值数据（可能尚未采集）" style={{ padding: 60 }} />
      ) : (
        <ResponsiveContainer width="100%" height={340}>
          <AreaChart
            data={sliced}
            margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
            onMouseMove={(s) => {
              // recharts 3 不再提供 activePayload，改用 activeTooltipIndex 定位当前点
              const idx = typeof s?.activeTooltipIndex === 'number' ? s.activeTooltipIndex : null
              const p = idx != null ? sliced[idx] : undefined
              if (p) setActive(p)
            }}
            onMouseLeave={() => setActive(null)}
          >
            <defs>
              <linearGradient id="ruleNavFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lineColor} stopOpacity={0.22} />
                <stop offset="100%" stopColor={lineColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={token.colorBorderSecondary} />
            <XAxis dataKey="date" tickFormatter={fmtTick} interval={tickGap} tick={axisTick} minTickGap={16} />
            <YAxis domain={['auto', 'auto']} tickFormatter={(v) => v.toFixed(2)} width={52} tick={axisTick} />
            <Tooltip
              cursor={{ stroke: token.colorTextTertiary, strokeDasharray: '3 3' }}
              content={({ active: a, payload }) => {
                if (!a || !payload?.length) return null
                const p = payload[0].payload as NavPoint
                const pp = first ? ((p.nav - first) / first) * 100 : 0
                return (
                  <div
                    style={{
                      background: token.colorBgElevated,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      borderRadius: token.borderRadius,
                      padding: '6px 10px',
                      fontSize: 12,
                    }}
                  >
                    <div style={{ color: token.colorTextSecondary }}>{p.date}</div>
                    <div style={{ color: token.colorText }}>净值 {p.nav.toFixed(4)}</div>
                    <div style={{ color: pp >= 0 ? UP : DOWN }}>
                      较首日 {pp >= 0 ? '+' : ''}{pp.toFixed(2)}%
                    </div>
                  </div>
                )
              }}
            />
            {active && (
              <ReferenceLine y={active.nav} stroke={token.colorTextTertiary} strokeDasharray="3 3" ifOverflow="extendDomain" />
            )}
            {/* 成本价实线 */}
            {costPrice != null && (
              <ReferenceLine
                y={costPrice}
                stroke={COST}
                strokeWidth={1.4}
                ifOverflow="extendDomain"
                label={{ value: `成本 ${costPrice.toFixed(4)}`, position: 'insideTopRight', fontSize: 11, fill: COST }}
              />
            )}
            {/* 4 条规则触发净值虚线：补仓红色系、止盈绿色 */}
            {rules.map((r) => (
              <ReferenceLine
                key={r.id}
                y={r.trigger_nav}
                stroke={RULE_COLORS[r.rule_type]}
                strokeDasharray="6 3"
                ifOverflow="extendDomain"
                label={{
                  value: `${ruleLabel(r)} ${r.trigger_nav.toFixed(4)}`,
                  position: r.rule_type === 'take_profit' ? 'insideTopLeft' : 'insideBottomLeft',
                  fontSize: 11,
                  fill: RULE_COLORS[r.rule_type],
                }}
              />
            ))}
            <Area type="monotone" dataKey="nav" stroke={lineColor} strokeWidth={1.6} fill="url(#ruleNavFill)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Modal>
  )
}

function statusColor(status: string): string {
  if (status === '触发止盈') return 'gold'
  if (status.startsWith('触发补仓')) return 'red'
  if (status === '数据缺失') return 'orange'
  return 'blue'
}
