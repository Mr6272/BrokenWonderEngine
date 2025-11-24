# BrokenWonder UI layer

Screen-space UI built on JOGL. Elements render in window coordinates, respond to mouse clicks, and render text via `TextRenderer`.

Usage outline:
- Create elements: `UIPanel(name, x, y, width, height)`, `UILabel(name, text, x, y)`, `UIButton(name, text, x, y, width, height)`, `UIImage(name, sprite, x, y, width, height)` (Sprite 单张/多帧/Atlas 均可).
- Register roots with `UIManager.getInstance().addElement(...)`; use `UIElement.addChild(...)` to build hierarchies.
- Configure visuals: `UIPanel.setBackgroundColor(...)`, `UIPanel.setBorder(...)`, `UILabel.setColor(...)`, `UIButton.setHoverColor(...)`, `UIButton.setPressColor(...)`, `UIElement.setZIndex(...)` for layering.
- Interactions: wire `UIButton.setOnClick(Runnable)`; hover/press states are handled automatically from the global mouse tracker.
- Visibility/control: `UIElement.setVisible(...)`, `UIElement.setEnabled(...)`, `UIManager.removeElement(...)`, `UIManager.clear()` to manage lifetime.
- Input is collected from the window’s `GLCanvas` (mouse listeners are attached in `MainWindow`), and rendering is driven each frame from `GameRenderer`.

Tween (lightweight, DOTween-style):
- Factory methods live in `UITweens`, driven automatically via `UITweenManager` (tick is already in `UIManager.update` with dt = 1/`GameRenderer.Frame`).
- Move: `UITweens.moveTo(element, toX, toY, duration, Ease, onComplete);`
- Resize: `UITweens.sizeTo(element, toW, toH, duration, Ease, onComplete);`
- Panel alpha: `UITweens.fadePanelAlpha(panel, targetAlpha, duration, Ease, onComplete);` (0~255)
- Shake position: `UITweens.shakePosition(element, amplitudePx, duration, Ease, onComplete);` (auto decay and reset)
- Looping: all factories have `(..., Ease, LoopType, loopCount, onComplete)`, where `loopCount` < 0 = infinite, 0 = no loop, >0 = loop count; `LoopType` supports `None`, `Loop`, `PingPong`. Easing: `Linear`, `EaseIn`, `EaseOut`, `EaseInOut`.

Images:
- Use `UIImage` with a `Sprite` (Single/Multiple/Atlas). Optional: `setAutoPlay(true)` for multi/atlas animation, `setFrameRate(fps)`, `setFrame(idx)` to choose a frame.

JSON layout loading (Data/ui_layout.json):
- Structure: `{ "groups": [ { "name": "...", "elements": [ ... ] } ] }`, each element supports `type` (panel|label|button|image|text), `name`, `position{x,y}`, `size{width,height}`, `zIndex`, `visible`, `enabled`, `background`, `border{color,thickness}`, `text/color/textColor/hoverColor/pressColor`, `sprite` (single/multiple/atlas), `imagePath/imageUrl`, `autoPlay`, `frameRate`, `frame`, `fitSpriteSize`, `children`. Text extras: `maxWidth`, `lineSpacing`, `align` (Left/Center/Right).
- Load everything: `UIManager.getInstance().loadLayoutFromJson("Data/ui_layout.json");`, load a named group: `loadGroupFromJson("Data/ui_layout.json", "example");`, or a single element: `loadElementFromJson("Data/ui_layout.json", "hud_panel")`.
- Hot reload: pressing F5 rebuilds the last loaded layout/group (defaults to `Data/ui_layout.json` for the whole layout). Use `setHotReloadTarget(path, groupName)` to change what F5 refreshes.
