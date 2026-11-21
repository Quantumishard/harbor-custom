// Free seek and speed steps, and the slow speed toggle (Settings → Hotkeys).
const seekSteps: Record<string, string> = {
  "Long seek back": "長く戻る",
  "Long seek forward": "長く進む",
  "Jump back by the Long seek step set under Behavior (30 seconds by default).":
    "動作で設定した長いシークの幅だけ戻ります（既定は 30 秒）。",
  "Jump forward by the Long seek step set under Behavior (30 seconds by default).":
    "動作で設定した長いシークの幅だけ進みます（既定は 30 秒）。",
  "Long seek": "長いシーク",
  "The jump of the Long seek back and Long seek forward shortcuts.":
    "「長く戻る」「長く進む」ショートカットのジャンプ幅です。",
  "Speed step": "速度の刻み",
  "How much the Speed down and Speed up shortcuts change the speed per press.":
    "「再生速度を下げる」「再生速度を上げる」ショートカットを 1 回押すごとに変わる速度の量です。",
  "Slow speed": "低速",
  "The speed the Toggle slow speed shortcut switches to from normal speed.":
    "「低速を切り替え」ショートカットが通常速度から切り替える速度です。",
  "Toggle slow speed": "低速を切り替え",
  "Switch between normal speed and the slow speed set under Behavior (0.5x by default).":
    "通常速度と、動作で設定した低速（既定は 0.5x）を切り替えます。",
  "Slow playback by the Speed step set under Behavior (0.25x by default).":
    "「動作」で設定した速度の刻みだけ再生を遅くします（既定は 0.25x）。",
  "Speed playback up by the Speed step set under Behavior (0.25x by default).":
    "「動作」で設定した速度の刻みだけ再生を速くします（既定は 0.25x）。",
  "Down step": "下げる刻み",
  "Up step": "上げる刻み",
  "1 second": "1秒",
  "{n} seconds": "{n}秒",
};

export default seekSteps;
