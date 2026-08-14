#!/usr/bin/env bash
# iFund 每日规则刷新任务：每个交易日 21:35 拉取最新净值并评估规则，
# 有触发待执行时弹 macOS 通知。基于 launchd 常驻。
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
LABEL="com.ifund.daily-rules"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/ifund"
DOMAIN="gui/$(id -u)"

write_plist() {
  mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BACKEND/venv/bin/python</string>
    <string>-m</string><string>cli</string>
    <string>rules</string><string>daily</string>
  </array>
  <key>WorkingDirectory</key><string>$BACKEND</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>35</integer></dict>
  <key>StandardOutPath</key><string>$LOGDIR/daily-rules.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/daily-rules.log</string>
</dict>
</plist>
EOF
}

case "${1:-}" in
  install)
    write_plist
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "每日任务已安装：每个自然日 21:35 运行（非交易日拉不到新净值，评估结果不变）"
    echo "日志：$LOGDIR/daily-rules.log"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && echo "已卸载" || echo "未在运行"
    rm -f "$PLIST"
    ;;
  run)      # 手动立即执行一次（调试用）
    cd "$BACKEND" && ./venv/bin/python -m cli rules daily
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state|last exit|pid" || echo "未安装/未运行"
    ;;
  logs)
    tail -50 "$LOGDIR/daily-rules.log"
    ;;
  *)
    echo "用法: $0 {install|uninstall|run|status|logs}"
    exit 1
    ;;
esac
