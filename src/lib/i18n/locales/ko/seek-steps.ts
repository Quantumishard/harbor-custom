// Free seek and speed steps, and the slow speed toggle (Settings → Hotkeys).
const seekSteps: Record<string, string> = {
  "Long seek back": "긴 뒤로 탐색",
  "Long seek forward": "긴 앞으로 탐색",
  "Jump back by the Long seek step set under Behavior (30 seconds by default).":
    "동작에서 정한 긴 탐색 폭만큼 뒤로 갑니다(기본 30초).",
  "Jump forward by the Long seek step set under Behavior (30 seconds by default).":
    "동작에서 정한 긴 탐색 폭만큼 앞으로 갑니다(기본 30초).",
  "Long seek": "긴 탐색",
  "The jump of the Long seek back and Long seek forward shortcuts.":
    "긴 뒤로 탐색과 긴 앞으로 탐색 단축키의 이동 폭입니다.",
  "Speed step": "속도 단계",
  "How much the Speed down and Speed up shortcuts change the speed per press.":
    "속도 낮추기/높이기 단축키를 한 번 누를 때 바뀌는 속도입니다.",
  "Slow speed": "느린 속도",
  "The speed the Toggle slow speed shortcut switches to from normal speed.":
    "느린 속도 전환 단축키가 보통 속도에서 바꾸는 속도입니다.",
  "Toggle slow speed": "느린 속도 전환",
  "Switch between normal speed and the slow speed set under Behavior (0.5x by default).":
    "보통 속도와 동작에서 정한 느린 속도(기본 0.5x) 사이를 전환합니다.",
  "Slow playback by the Speed step set under Behavior (0.25x by default).":
    "동작에서 정한 속도 단계만큼 재생을 느리게 합니다(기본 0.25x).",
  "Speed playback up by the Speed step set under Behavior (0.25x by default).":
    "동작에서 정한 속도 단계만큼 재생을 빠르게 합니다(기본 0.25x).",
  "Down step": "낮출 때 간격",
  "Up step": "높일 때 간격",
  "1 second": "1초",
  "{n} seconds": "{n}초",
};

export default seekSteps;
