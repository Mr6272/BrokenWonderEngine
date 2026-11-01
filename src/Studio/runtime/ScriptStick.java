package Studio.runtime;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 虚拟摇杆 / 虚拟按键（引擎内建模块，脚本 API 是 {@code bwe.stick}）。
 *
 * <p><b>为什么做在引擎里而不是脚本里</b>：手机玩桌面向游戏时，「WASD + 空格 + 回车 + Tab + Esc」
 * 这些常用键在触屏上没法按。每个工程各写一套虚拟按键，既重复又容易和 HUD 抢层级。
 * 做成引擎模块后：脚本一行 {@code bwe.stick.mount({keys:["WASD","space"]})} 就能得到
 * 可用的按钮/摇杆，并且<b>自动与 HUD 分层</b>（绘制在最上层，输入优先于场景点击）。
 *
 * <p><b>按键布局语法</b>（一个字符串，逗号分隔，每一项是「一个按钮」或「一个十字团」）：
 * <pre>
 *   "WASD"         → 左下角十字摇杆（同时映射 W/A/S/D 四个键状态）
 *   "space"        → 独立圆按钮（映射空格）
 *   "enter"        → 独立圆按钮
 *   "tab" / "esc"  → 独立圆按钮
 *   "up,down"      → 方向键
 *   "lmb" / "rmb"  → 鼠标左/右键（映射到 pointer）
 * </pre>
 * 也支持显式坐标：{@code {id:"space", x:0.5, y:0.85, r:0.06}}（x/y 为 0~1 归一化）。
 *
 * <p><b>输入优先级</b>：手指落在按键上时，引擎先消费该触摸（不让它变成场景点击），
 * 避免「点摇杆时顺手把地图点了一下」。
 */
final class ScriptStick {

    /** 一个虚拟按键/摇杆的几何与状态。 */
    static final class Control {
        final String id;
        /** 归一化矩形（0~1，相对逻辑视口）。 */
        float nx, ny, nw, nh;
        /** 触发的按键码（摇杆有多个方向键码）。 */
        int[] keyCodes = new int[0];
        /** 摇杆中心与半径（归一化）；仅摇杆用。 */
        boolean analog;
        float cxN, cyN, radiusN;
        /** 当前状态。 */
        boolean pressed;
        /** 摇杆归一化偏移（-1..1）。 */
        float axisX, axisY;
        /** 按下的 pointerId（-1 = 没按）。 */
        int activePointer = -1;

        Control(String id) {
            this.id = id;
        }
    }

    private final TopDownRuntime host;
    private final List<Control> controls = new ArrayList<Control>();
    private boolean visible = true;
    private float opacity = 0.55f;
    private boolean mounted;

    ScriptStick(TopDownRuntime host) {
        this.host = host;
    }

    boolean isMounted() {
        return mounted;
    }

    boolean isVisible() {
        return visible;
    }

    void setVisible(boolean v) {
        visible = v;
    }

    float opacity() {
        return opacity;
    }

    void setOpacity(float v) {
        opacity = Math.max(0.1f, Math.min(1f, v));
    }

    List<Control> controls() {
        return controls;
    }

    /**
     * 按布局语法生成按键（默认布局：十字摇杆 + 空格 + 回车 + Tab + Esc）。
     *
     * @param spec 逗号分隔的按键描述；空串或 null 用默认
     */
    void mount(String spec) {
        controls.clear();
        String s = spec == null ? "" : spec.trim();
        if (s.isEmpty()) {
            s = "WASD,space,enter,tab,esc";
        }
        String[] parts = s.split(",");
        int rightCount = 0;
        for (String raw : parts) {
            String item = raw.trim();
            if (item.isEmpty()) {
                continue;
            }
            String lower = item.toLowerCase();
            if (lower.equals("wasd") || lower.equals("cross")) {
                addAnalog("WASD");
            } else if (lower.equals("arrows") || lower.equals("dpad")) {
                addAnalog("arrows");
            } else {
                // 独立按钮：靠右下角依次排布（避开常见的左侧摇杆区）
                Control c = new Control(keyIdOf(lower));
                c.keyCodes = new int[]{keyCodeOf(lower)};
                c.nw = 0.075f;
                c.nh = 0.11f;
                c.nx = 0.86f;
                c.ny = 0.70f - rightCount * 0.13f;
                controls.add(c);
                rightCount++;
            }
        }
        mounted = true;
    }

    private void addAnalog(String kind) {
        Control c = new Control(kind);
        c.analog = true;
        c.keyCodes = kind.equals("arrows")
                ? new int[]{java.awt.event.KeyEvent.VK_UP, java.awt.event.KeyEvent.VK_DOWN,
                java.awt.event.KeyEvent.VK_LEFT, java.awt.event.KeyEvent.VK_RIGHT}
                : new int[]{java.awt.event.KeyEvent.VK_W, java.awt.event.KeyEvent.VK_A,
                java.awt.event.KeyEvent.VK_S, java.awt.event.KeyEvent.VK_D};
        c.cxN = 0.12f;
        c.cyN = 0.76f;
        c.radiusN = 0.075f;
        c.nx = c.cxN - c.radiusN;
        c.ny = c.cyN - c.radiusN;
        c.nw = c.radiusN * 2f;
        c.nh = c.radiusN * 2f;
        controls.add(c);
    }

    private static String keyIdOf(String s) {
        switch (s) {
            case "space":
            case "空格":
                return "space";
            case "enter":
            case "return":
            case "回车":
                return "enter";
            case "tab":
                return "tab";
            case "esc":
            case "escape":
                return "esc";
            default:
                return s;
        }
    }

    private static int keyCodeOf(String s) {
        switch (s) {
            case "space": return java.awt.event.KeyEvent.VK_SPACE;
            case "enter":
            case "return": return java.awt.event.KeyEvent.VK_ENTER;
            case "tab": return java.awt.event.KeyEvent.VK_TAB;
            case "esc":
            case "escape": return java.awt.event.KeyEvent.VK_ESCAPE;
            case "up": return java.awt.event.KeyEvent.VK_UP;
            case "down": return java.awt.event.KeyEvent.VK_DOWN;
            case "left": return java.awt.event.KeyEvent.VK_LEFT;
            case "right": return java.awt.event.KeyEvent.VK_RIGHT;
            default: return 0;
        }
    }

    // ---------------- 触摸处理 ----------------

    /**
     * 按下：命中哪个按键就消费该触摸（返回 true = 引擎已处理，不再派发场景点击）。
     *
     * @param lx,ly 逻辑视口坐标
     */
    boolean pointerDown(int pointerId, float lx, float ly) {
        if (!mounted || !visible) {
            return false;
        }
        float nx = lx / Math.max(1f, host.view.viewW);
        float ny = ly / Math.max(1f, host.view.viewH);
        for (Control c : controls) {
            if (c.activePointer >= 0) {
                continue;
            }
            if (!inside(c, nx, ny)) {
                continue;
            }
            c.activePointer = pointerId;
            c.pressed = true;
            if (c.analog) {
                updateAxis(c, nx, ny);
            } else {
                setKey(c, true);
            }
            return true;
        }
        return false;
    }

    /** 移动：更新摇杆轴；落在按键外的已按下摇杆继续跟手（手机摇杆的标准手感）。 */
    boolean pointerMove(int pointerId, float lx, float ly) {
        if (!mounted || !visible) {
            return false;
        }
        boolean consumed = false;
        float nx = lx / Math.max(1f, host.view.viewW);
        float ny = ly / Math.max(1f, host.view.viewH);
        for (Control c : controls) {
            if (c.activePointer != pointerId) {
                continue;
            }
            consumed = true;
            if (c.analog) {
                updateAxis(c, nx, ny);
            }
        }
        return consumed;
    }

    /** 抬起：清状态。 */
    boolean pointerUp(int pointerId) {
        if (!mounted) {
            return false;
        }
        boolean consumed = false;
        for (Control c : controls) {
            if (c.activePointer != pointerId) {
                continue;
            }
            consumed = true;
            c.activePointer = -1;
            c.pressed = false;
            if (c.analog) {
                c.axisX = 0f;
                c.axisY = 0f;
                for (int code : c.keyCodes) {
                    setKeyCode(code, false);
                }
            } else {
                setKey(c, false);
            }
        }
        return consumed;
    }

    /** 全部松开（失焦/暂停时调，避免「按键卡住」）。 */
    void releaseAll() {
        for (Control c : controls) {
            c.activePointer = -1;
            c.pressed = false;
            c.axisX = 0f;
            c.axisY = 0f;
            for (int code : c.keyCodes) {
                setKeyCode(code, false);
            }
        }
    }

    private static boolean inside(Control c, float nx, float ny) {
        return nx >= c.nx && nx <= c.nx + c.nw && ny >= c.ny && ny <= c.ny + c.nh;
    }

    /** 摇杆：把手指位置换算成归一化轴值（死区 15%，超出半径夹到 1）。 */
    private void updateAxis(Control c, float nx, float ny) {
        float dx = (nx - c.cxN) / c.radiusN;
        float dy = (ny - c.cyN) / c.radiusN;
        float len = (float) Math.sqrt(dx * dx + dy * dy);
        if (len < 0.15f) {
            c.axisX = 0f;
            c.axisY = 0f;
        } else {
            if (len > 1f) {
                dx /= len;
                dy /= len;
                len = 1f;
            }
            c.axisX = dx;
            c.axisY = dy;
        }
        // 同步到按键状态（这样脚本用 bwe.input.down("W") 也能读到）
        boolean[] dirs = new boolean[]{c.axisY < -0.35f, c.axisY > 0.35f, c.axisX < -0.35f, c.axisX > 0.35f};
        for (int i = 0; i < c.keyCodes.length && i < dirs.length; i++) {
            setKeyCode(c.keyCodes[i], dirs[i]);
        }
    }

    private void setKey(Control c, boolean down) {
        for (int code : c.keyCodes) {
            setKeyCode(code, down);
        }
    }

    private void setKeyCode(int code, boolean down) {
        if (code <= 0 || code >= host.keys.length) {
            return;
        }
        host.keys[code] = down;
    }

    // ---------------- 状态查询（给 bwe.stick 的脚本 API） ----------------

    /** 摇杆轴值（没按 = 0,0）。 */
    float[] axis() {
        for (Control c : controls) {
            if (c.analog) {
                return new float[]{c.axisX, c.axisY};
            }
        }
        return new float[]{0f, 0f};
    }

    /** 某个按键的按下状态（包括被摇杆映射的方向键）。 */
    boolean pressed(String id) {
        if (id == null || id.isEmpty()) {
            return false;
        }
        String lower = id.toLowerCase();
        for (Control c : controls) {
            if (c.id.toLowerCase().equals(lower) && c.pressed) {
                return true;
            }
            for (int code : c.keyCodes) {
                if (keyCodeOf(lower) == code && code > 0 && code < host.keys.length && host.keys[code]) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 诊断/测试：当前布局摘要。 */
    String describe() {
        StringBuilder sb = new StringBuilder();
        for (Control c : controls) {
            if (sb.length() > 0) {
                sb.append(',');
            }
            sb.append(c.id);
            if (c.analog) {
                sb.append("(analog)");
            }
        }
        return sb.toString();
    }

    /** 测试用：直接给一个按键设状态（无触摸环境下的自检）。 */
    void debugSetKey(int code, boolean down) {
        setKeyCode(code, down);
    }

    /** 测试用：直接注入摇杆轴值。 */
    void debugSetAxis(float x, float y) {
        for (Control c : controls) {
            if (c.analog) {
                c.axisX = x;
                c.axisY = y;
            }
        }
    }
}
