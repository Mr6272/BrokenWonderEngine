# BrokenWonder UI layer

Screen-space UI built on JOGL. Elements render in window coordinates, respond to mouse clicks, and render text via `TextRenderer`.

Usage outline (no sample code):
- Create elements: `UIPanel(name, x, y, width, height)`, `UILabel(name, text, x, y)`, `UIButton(name, text, x, y, width, height)`.
- Register roots with `UIManager.getInstance().addElement(...)`; use `UIElement.addChild(...)` to build hierarchies.
- Configure visuals: `UIPanel.setBackgroundColor(...)`, `UIPanel.setBorder(...)`, `UILabel.setColor(...)`, `UIButton.setHoverColor(...)`, `UIButton.setPressColor(...)`, `UIElement.setZIndex(...)` for layering.
- Wire interactions with `UIButton.setOnClick(Runnable)`; hover/press states are handled automatically from the global mouse tracker.
- Visibility/control: `UIElement.setVisible(...)`, `UIElement.setEnabled(...)`, `UIManager.removeElement(...)`, `UIManager.clear()` to manage lifetime.
- Input is collected from the window’s `GLCanvas` (mouse listeners are attached in `MainWindow`), and rendering is driven each frame from `GameRenderer`.

Tween (lightweight, DOTween-style):
- Factory methods in `UITweens`, driven automatically via `UITweenManager` (tick is already in `UIManager.update` with dt=1/`GameRenderer.Frame`).
- Move: `UITweens.moveTo(element, toX, toY, duration, Ease, onComplete);`
- Resize: `UITweens.sizeTo(element, toW, toH, duration, Ease, onComplete);`
- Panel alpha: `UITweens.fadePanelAlpha(panel, targetAlpha, duration, Ease, onComplete);` (0–255)
- Shake position: `UITweens.shakePosition(element, amplitude, duration, Ease, onComplete);`（振幅像素值，自动衰减并复位）
- Looping（可选参数）：所有工厂均有重载 `(..., Ease, LoopType, loopCount, onComplete)`，`loopCount` < 0 为无限循环，0 为不循环，正数为循环次数；`LoopType` 支持 `None`, `Loop`, `PingPong`。
- Ease options: `Linear`, `EaseIn`, `EaseOut`, `EaseInOut`.
