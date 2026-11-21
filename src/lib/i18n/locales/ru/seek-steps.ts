// Free seek and speed steps, and the slow speed toggle (Settings → Hotkeys).
const seekSteps: Record<string, string> = {
  "Long seek back": "Длинный переход назад",
  "Long seek forward": "Длинный переход вперёд",
  "Jump back by the Long seek step set under Behavior (30 seconds by default).":
    "Перематывает назад на длинный шаг, заданный в разделе «Поведение» (по умолчанию 30 секунд).",
  "Jump forward by the Long seek step set under Behavior (30 seconds by default).":
    "Перематывает вперёд на длинный шаг, заданный в разделе «Поведение» (по умолчанию 30 секунд).",
  "Long seek": "Длинный переход",
  "The jump of the Long seek back and Long seek forward shortcuts.":
    "Шаг сочетаний «Длинный переход назад» и «Длинный переход вперёд».",
  "Speed step": "Шаг скорости",
  "How much the Speed down and Speed up shortcuts change the speed per press.":
    "Насколько горячие клавиши «Медленнее» и «Быстрее» меняют скорость за одно нажатие.",
  "Slow speed": "Медленная скорость",
  "The speed the Toggle slow speed shortcut switches to from normal speed.":
    "Скорость, на которую сочетание «Переключить медленную скорость» переходит с обычной.",
  "Toggle slow speed": "Переключить медленную скорость",
  "Switch between normal speed and the slow speed set under Behavior (0.5x by default).":
    "Переключает между обычной скоростью и медленной, заданной в разделе «Поведение» (по умолчанию 0,5x).",
  "Slow playback by the Speed step set under Behavior (0.25x by default).":
    "Замедляет воспроизведение на шаг скорости из раздела «Поведение» (по умолчанию 0,25x).",
  "Speed playback up by the Speed step set under Behavior (0.25x by default).":
    "Ускоряет воспроизведение на шаг скорости из раздела «Поведение» (по умолчанию 0,25x).",
  "Down step": "Шаг вниз",
  "Up step": "Шаг вверх",
  "1 second": "1 секунда",
  "{n} seconds": "{n} секунд",
  "{n} seconds#one": "{n} секунда",
  "{n} seconds#few": "{n} секунды",
};

export default seekSteps;
