import { useCallback, useEffect, useState } from 'react'
import { Card, Empty, List, Space, Tag, Typography } from 'antd'
import { BellOutlined } from '@ant-design/icons'
import request from '../../api/request'
import { RULE_COLORS } from './types'
import type { RuleAlert } from './types'

const fmtMoney = (v: number) =>
  v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Dashboard 首页「规则触发提醒」：已触发且未执行的补仓/止盈规则一览。 */
export default function RuleAlertsCard() {
  const [items, setItems] = useState<RuleAlert[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await request.get<{ items: RuleAlert[] }>('/rules/alerts')
      setItems(data.items ?? [])
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <Card
      size="small"
      title={
        <Space size={6}>
          <BellOutlined />
          <span>规则触发提醒</span>
          {items.length > 0 && <Tag color="red">{items.length} 条待执行</Tag>}
        </Space>
      }
    >
      {items.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={loading ? '加载中…' : '今日无触发'}
          style={{ margin: '8px 0' }}
        />
      ) : (
        <List
          size="small"
          loading={loading}
          dataSource={items}
          renderItem={(a) => (
            <List.Item style={{ padding: '6px 0' }}>
              <Space size={8} wrap>
                <Tag color={RULE_COLORS[a.rule_type]} style={{ color: '#fff', marginInlineEnd: 0 }}>
                  {a.rule_label}
                </Tag>
                <Typography.Text strong>{a.fund_name}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {a.fund_code}
                </Typography.Text>
                <Typography.Text>{a.action}</Typography.Text>
                <Typography.Text type="danger">¥{fmtMoney(a.amount)}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  触发净值 {a.trigger_nav.toFixed(4)} · 最新 {a.latest_nav?.toFixed(4) ?? '—'}
                  {a.nav_date ? `（${a.nav_date}）` : ''}
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      )}
    </Card>
  )
}
