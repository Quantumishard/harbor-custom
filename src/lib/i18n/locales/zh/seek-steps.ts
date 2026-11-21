// Free seek and speed steps, and the slow speed toggle (Settings → Hotkeys).
const seekSteps: Record<string, string> = {
  "Long seek back": "长距离后退",
  "Long seek forward": "长距离前进",
  "Jump back by the Long seek step set under Behavior (30 seconds by default).":
    "按“行为”中设置的长跳转幅度后退（默认 30 秒）。",
  "Jump forward by the Long seek step set under Behavior (30 seconds by default).":
    "按“行为”中设置的长跳转幅度前进（默认 30 秒）。",
  "Long seek": "长跳转",
  "The jump of the Long seek back and Long seek forward shortcuts.":
    "“长距离后退”和“长距离前进”快捷键的跳转幅度。",
  "Speed step": "速度步长",
  "How much the Speed down and Speed up shortcuts change the speed per press.":
    "每按一次“减速”和“加速”快捷键时速度变化的幅度。",
  "Slow speed": "慢速",
  "The speed the Toggle slow speed shortcut switches to from normal speed.":
    "“切换慢速”快捷键从正常速度切换到的速度。",
  "Toggle slow speed": "切换慢速",
  "Switch between normal speed and the slow speed set under Behavior (0.5x by default).":
    "在正常速度和“行为”中设置的慢速（默认 0.5x）之间切换。",
  "Slow playback by the Speed step set under Behavior (0.25x by default).":
    "按“行为”中设置的速度步长减慢播放（默认 0.25x）。",
  "Speed playback up by the Speed step set under Behavior (0.25x by default).":
    "按“行为”中设置的速度步长加快播放（默认 0.25x）。",
  "Down step": "减速步长",
  "Up step": "加速步长",
  "1 second": "1 秒",
  "{n} seconds": "{n} 秒",
};

export default seekSteps;
