package Studio.runtime;

import java.util.ArrayList;
import java.util.List;

/**
 * 文本输入框 / 数字输入（引擎内建模块，脚本 API 是 {@code bwe.textinput}）。
 *
 * <p><b>解决什么问题</b>：桌面端靠键盘直接敲数字（游戏里的行/列/雷数这类参数），
 * 手机上却没有键盘 —— 只能靠 +/- 小箭头一格一格点，改「40 雷」要点 30 多次。
 * 本模块提供一个「点一下就激活、然后直接键入」的输入框：
 * <ul>
 *   <li>桌面端：点击激活后，物理键盘输入的字符进框（退格、回车确认、Esc 取消）；</li>
 *   <li>Android：点击激活后，请求宿主弹出系统软键盘；字符经同一个 {@link #type(char)} 入口进来。</li>
 * </ul>
 * 两端共用同一套状态机，所以行为一致，只是「字符从哪来」由各平台后端决定。
 *
 * <p><b>为什么放在引擎而不是脚本里</b>：软键盘的显示/隐藏是平台能力，脚本拿不到；
 * 而「框在哪、输入什么、校验什么」是纯逻辑。拆成「引擎管状态机 + 宿主管软键盘」最干净。
 *
 * <p><b>关键设计</b>：输入框只维护「正在编辑的文本」和「光标激活状态」，
 * <b>不持有业务值</b> —— 值从提交回调里给脚本，避免引擎里长出业务字段。
 */
final class ScriptTextInput {

    /** 一个输入框。 */
    static final class Field {
        /** 业务 id（脚本用来识别是哪个框，例如 "rows"/"cols"/"mines"）。 */
        final String id;
        /** 当前编辑中的文本（激活时是用户敲的，未激活时是显示值）。 */
        String text = "";
        /**
         * 输入法<b>组合段</b>（拼音/联想还没选字的部分，数字键盘逐键预演也算）。
         *
         * <p>与 {@link #text} 分开：{@code text} 是已落字的正文，本字段是"还可能被整体
         * 替换"的临时段。输入法每次 {@code setComposingText} 只替换这一段，
         * {@code commitText} 时才并入 {@link #text}。旧实现把它们混成一个整体替换，
         * 导致「打多个数字只剩最后一个」「有时完全输不进」。
         */
        String composing = "";
        /** 是否处于编辑态。 */
        boolean active;
        /** 数值范围（数字模式用；0 表示不限）。 */
        int min;
        int max;
        /** 是否只允许整数。 */
        boolean numeric;
        /** 最大字符数（防止输入过长的数字撑破 UI）。 */
        int maxChars = 8;
        /** 是否居中显示（HUD 里的数字框通常居中）。 */
        boolean centered = true;
        /** 字段的归一化屏幕矩形（0~1，相对逻辑视口），用于命中测试与绘制。 */
        float nx, ny, nw, nh;
        /** 光标的闪烁相位。 */
        float caretPhase;
        /** 输入超出范围时的提示（空 = 无提示）。脚本可用它画红框/警告。 */
        String hint = "";

        Field(String id) {
            this.id = id;
        }
    }

    /** 宿主需要实现的软键盘后端（Android 弹键盘 / 桌面什么都不做）。 */
    interface KeyboardHost {
        /** 请求显示 / 隐藏软键盘。 */
        void setSoftKeyboardVisible(boolean visible);
    }

    private final List<Field> fields = new ArrayList<Field>();
    private KeyboardHost keyboardHost;
    /** 字段内容变化时回调（脚本绑定）。 */
    private Runnable onChange;
    /** 回车确认时回调（脚本绑定）。 */
    private java.util.function.Consumer<Field> onSubmit;

    /** 当前激活的字段（没有为 null）。 */
    private Field activeField;

    void setKeyboardHost(KeyboardHost host) {
        this.keyboardHost = host;
    }

    void setOnChange(Runnable r) {
        this.onChange = r;
    }

    void setOnSubmit(java.util.function.Consumer<Field> c) {
        this.onSubmit = c;
    }

    /** 新建/覆盖一个输入框。 */
    Field define(String id, String initialValue, int min, int max, boolean numeric) {
        Field f = find(id);
        if (f == null) {
            f = new Field(id);
            fields.add(f);
        }
        // ⚠ 只更新「显示值」，**不要动正在编辑中的文本**。
        //
        // 脚本每帧都会调 define(id, 业务值, ...) 来同步布局（因为框的位置会随窗口变）。
        // 如果这里无条件覆盖 f.text，用户刚敲进去的字符会在下一帧被业务值冲掉 ——
        // 表现就是「点了能激活、键盘也弹了，但数字一个都输不进去」。
        if (!f.active) {
            f.text = initialValue == null ? "" : initialValue;
        }
        f.min = min;
        f.max = max;
        f.numeric = numeric;
        return f;
    }

    Field find(String id) {
        for (Field f : fields) {
            if (f.id.equals(id)) {
                return f;
            }
        }
        return null;
    }

    List<Field> fields() {
        return fields;
    }

    /**
     * 校验某字段当前文本是否在 [min,max] 内。
     *
     * <p><b>为什么要暴露这个</b>：输入框如果把「敲进去的值」和「实际生效的值」悄悄不一致，
     * 玩家会觉得「我输入 1，结果变成 5，UI 炸了」。脚本拿到这个提示就能
     * 在框边画红字/红框，明确告诉玩家「这个值不行」。
     *
     * @return 空串 = 合法；否则是给玩家看的中文提示
     */
    String validate(String id) {
        Field f = find(id);
        if (f == null) {
            return "";
        }
        String t = visibleText(f).trim();
        if (t.isEmpty()) {
            return "不能为空";
        }
        if (f.numeric) {
            try {
                int v = Integer.parseInt(t);
                if (f.min > 0 && v < f.min) {
                    return "最小 " + f.min;
                }
                if (f.max > 0 && v > f.max) {
                    return "最大 " + f.max;
                }
            } catch (Exception e) {
                return "只能填数字";
            }
        }
        return "";
    }

    /** 刷新所有字段的 hint（脚本每帧可调；返回是否有任何字段非法）。 */
    boolean refreshHints() {
        boolean any = false;
        for (Field f : fields) {
            String h = validate(f.id);
            f.hint = h;
            if (!h.isEmpty() && f.active) {
                any = true;
            }
        }
        return any;
    }

    /** 某字段的当前文本（未激活就是显示值，激活中是用户正在敲的）。 */
    String textOf(String id) {
        Field f = find(id);
        return f == null ? "" : visibleText(f);
    }

    /** 某字段的整数解析结果（非法/为空时返回 fallback）。 */
    int intOf(String id, int fallback) {
        Field f = find(id);
        if (f == null) {
            return fallback;
        }
        try {
            int v = Integer.parseInt(visibleText(f).trim());
            if (f.min > 0 && v < f.min) {
                v = f.min;
            }
            if (f.max > 0 && v > f.max) {
                v = f.max;
            }
            return v;
        } catch (Exception e) {
            return fallback;
        }
    }

    boolean isActive() {
        return activeField != null;
    }

    Field activeField() {
        return activeField;
    }

    /**
     * 点击命中：点在某个输入框上就激活它（并请求软键盘），点在空白就提交当前输入。
     *
     * @param lx,ly 逻辑视口坐标
     * @return true = 该点击被输入框消费（不要再派发给场景）
     */
    boolean pointerDown(float lx, float ly, int viewW, int viewH) {
        Field hit = hitTest(lx, ly, viewW, viewH);
        if (hit != null) {
            if (activeField != null && activeField != hit) {
                commitActive();     // 切换框前先把上一个提交
            }
            activate(hit);
            return true;
        }
        if (activeField != null) {
            // 点空白：提交并收起键盘（常见的「点外面就确认」）
            commitActive();
            return true;
        }
        return false;
    }

    private Field hitTest(float lx, float ly, int viewW, int viewH) {
        if (viewW <= 0 || viewH <= 0) {
            return null;
        }
        float nx = lx / viewW;
        float ny = ly / viewH;
        for (Field f : fields) {
            if (nx >= f.nx && nx <= f.nx + f.nw && ny >= f.ny && ny <= f.ny + f.nh) {
                return f;
            }
        }
        return null;
    }

    void activate(Field f) {
        if (f == null) {
            return;
        }
        activeField = f;
        f.active = true;
        f.text = "";              // 激活即清空，用户直接敲新值（比「全选覆盖」更符合触摸直觉）
        f.composing = "";         // 组合段也必须清，否则上一次没落字的残段会拼进来
        f.caretPhase = 0f;
        if (keyboardHost != null) {
            keyboardHost.setSoftKeyboardVisible(true);
        }
    }

    /** 提交当前激活的框（应用新值并回调脚本）。 */
    boolean commitActive() {
        Field f = activeField;
        if (f == null) {
            return false;
        }
        activeField = null;
        f.active = false;
        // ⚠ 先把「组合段」并入正文再判空 / 回调。
        //
        // 这是「输入有时候完全无效」的第二个原因：旧代码判的是 {@code f.text}
        // （已落字正文），而某些输入法在「完成键」按下时内容还停在组合段里 ——
        // 此时 text 为空、composing 有值，判空直接命中 → 回调根本不触发 → 玩家觉得
        // 「打了字按完成，游戏一点反应都没有」。并进来之后才判，才代表玩家真正看到的内容。
        String finalText = visibleText(f).trim();
        f.composing = "";
        f.text = finalText;
        if (keyboardHost != null) {
            keyboardHost.setSoftKeyboardVisible(false);
        }
        // 非法值也提交给脚本 —— 由脚本统一 clamp 并在下次绘制时展示「已修正」。
        // 引擎不擅自丢弃玩家的输入（那会让「输入了但没反应」更困惑）。
        if (!finalText.isEmpty() && onSubmit != null) {
            onSubmit.accept(f);
            return true;
        }
        // 空输入：不回调业务，但仍然要发一次 onChange —— 脚本据此把框的显示值
        // 复位成业务值（否则框会停在空字符串，看起来像"输入被吞了"）。
        notifyChange();
        return true;
    }

    /** 取消编辑（Esc / 点取消）：恢复显示值，不回调。 */
    void cancelActive() {
        Field f = activeField;
        if (f == null) {
            return;
        }
        activeField = null;
        f.active = false;
        // 取消时把文本还原成「业务值」（由脚本下次 draw 时重新写回）
        f.text = "";
        f.composing = "";
        if (keyboardHost != null) {
            keyboardHost.setSoftKeyboardVisible(false);
        }
    }

    /**
     * 收到一个字符（桌面物理键盘与 Android 软键盘共用此入口）。
     *
     * @return true = 被输入框消费（宿主不应再把它当游戏按键）
     */
    boolean type(char ch) {
        Field f = activeField;
        if (f == null) {
            return false;
        }
        if (ch == '\b' || ch == 127) {          // 退格
            // 优先删组合段（输入法未落字的部分），再删正文 —— 与系统的编辑直觉一致。
            if (!f.composing.isEmpty()) {
                f.composing = f.composing.substring(0, f.composing.length() - 1);
                notifyChange();
                return true;
            }
            if (f.text.isEmpty()) {
                return true;
            }
            f.text = f.text.substring(0, f.text.length() - 1);
            notifyChange();
            return true;
        }
        if (ch == '\n' || ch == '\r') {         // 回车确认
            commitActive();
            return true;
        }
        if (ch < 32) {                          // 其它控制字符忽略
            return true;
        }
        if (f.numeric && (ch < '0' || ch > '9')) {
            return true;                        // 数字框只收数字
        }
        if (visibleText(f).length() >= f.maxChars) {
            return true;
        }
        f.text = f.text + ch;
        notifyChange();
        return true;
    }

    /**
     * 整体替换当前编辑框的文本（<b>给 Android 原生输入法用</b>）。
     *
     * <p>为什么不是 {@link #type(char)}：桌面端物理键盘是「一个键一个字符」，
     * 而 Android 的输入法（尤其数字键盘、带联想/组合输入的键盘）给的是
     * <b>整段文本</b>（{@code commitText} 里可能是多个字符，组合输入还会先给
     * 半成品再整体替换）。逐字符模拟必然和输入法的实际行为错位，
     * 所以这里直接同步「输入法框里现在是什么」。
     *
     * <p>过滤规则与 {@link #type} 保持一致（数字框只收数字、超长截断），
     * 这样输入法框与引擎里的值不会出现「看得见的和生效的不一样」。
     *
     * @return true = 文本确实变了（调用方可以据此避免无谓重绘）
     */
    boolean setActiveText(String text) {
        Field f = activeField;
        if (f == null) {
            return false;
        }
        String v = sanitize(f, text);
        if (v.equals(f.text)) {
            return false;
        }
        f.text = v;
        notifyChange();
        return true;
    }

    /**
     * 输入法<b>组合态</b>更新（拼音/联想还没选字，或数字键盘逐键预演）。
     *
     * <p><b>为什么要和 {@link #setActiveText} 分开（「输入有时候无效」的真因）</b>：
     * Android 输入法给文本是<b>两段式</b>协议 ——
     * <pre>
     *   setComposingText("7")   ← 组合中（可能被后续按键整体替换）
     *   commitText("7")         ← 落字（此后成为既有内容）
     * </pre>
     * 前者是<b>可被下一次组合整体覆盖的临时内容</b>，后者才进正式文本。
     * 旧实现把两者都当「整体替换整框文本」，于是：
     * <ul>
     *   <li>已敲进「7」之后再按「8」，输入法发 {@code setComposingText("8")}
     *       → <b>整体替换</b>把「7」覆盖掉，玩家看到「打了两个键只剩一个」；</li>
     *   <li>数字键盘/部分输入法在落字前会先发一次空组合态 → 把已输入内容清空，
     *       玩家表现为「输入完全无效」。</li>
     * </ul>
     *
     * <p>正确语义：<b>已提交的正文（{@link Field#text}）+ 当前组合段（{@link Field#composing}）</b>，
     * 每一次组合态只替换组合段，提交时把组合段并入正文。这也正是输入法
     * {@code getTextBeforeCursor} 期望看到的结构。
     */
    boolean setComposing(String text) {
        Field f = activeField;
        if (f == null) {
            return false;
        }
        String v = sanitize(f, text);
        if (v.equals(f.composing)) {
            return false;
        }
        f.composing = v;
        notifyChange();
        return true;
    }

    /**
     * 提交组合段（输入法 {@code commitText}）。
     *
     * <p>把组合段并入正文并清空组合态。若输入法直接给了一段完整文本
     * （数字键盘常见：先 {@code setComposingText} 再 {@code commitText} 同值），
     * 这里会得到「正文 = 旧正文 + 该段」，不会覆盖已输入内容。
     */
    boolean commitComposing(String text) {
        Field f = activeField;
        if (f == null) {
            return false;
        }
        String incoming = text == null ? "" : text;
        // 输入法给的这段若与当前组合段一致，说明是「把组合段落字」；
        // 否则是「直接给一段新文本」，同样追加进正文（不覆盖）。
        String add = incoming.isEmpty() ? f.composing : sanitize(f, incoming);
        f.composing = "";
        String merged = sanitize(f, f.text + add);
        if (merged.equals(f.text)) {
            notifyChange();
            return false;
        }
        f.text = merged;
        notifyChange();
        return true;
    }

    /** 过滤：数字框只留数字；统一截到 maxChars；顺带清掉换行。 */
    private static String sanitize(Field f, String text) {
        String v = text == null ? "" : text.replace("\n", "").replace("\r", "");
        if (f.numeric) {
            StringBuilder sb = new StringBuilder(v.length());
            for (int i = 0; i < v.length(); i++) {
                char ch = v.charAt(i);
                if (ch >= '0' && ch <= '9') {
                    sb.append(ch);
                }
            }
            v = sb.toString();
        }
        if (f.maxChars > 0 && v.length() > f.maxChars) {
            v = v.substring(0, f.maxChars);
        }
        return v;
    }

    /** 当前<b>可见</b>文本 = 已提交正文 + 组合段（输入法/绘制都该看到这个）。 */
    String visibleText(Field f) {
        if (f == null) {
            return "";
        }
        return f.text + f.composing;
    }

    /** 当前编辑框的文本（没有激活框时返回 null，供宿主同步输入法控件）。 */
    String activeText() {
        Field f = activeField;
        return f == null ? null : visibleText(f);
    }

    /** 当前编辑框的归一化矩形（没有激活框时返回 null）。 */
    float[] activeRect() {
        Field f = activeField;
        if (f == null) {
            return null;
        }
        return new float[]{f.nx, f.ny, f.nw, f.nh};
    }

    /** 当前编辑框是否只收数字。 */
    boolean activeNumeric() {
        Field f = activeField;
        return f != null && f.numeric;
    }

    /** 当前编辑框允许的最大字符数（0 = 不限）。 */
    int activeMaxChars() {
        Field f = activeField;
        return f == null ? 0 : f.maxChars;
    }

    /** Esc：取消编辑。 */
    boolean cancelKey() {
        if (activeField == null) {
            return false;
        }
        cancelActive();
        return true;
    }

    private void notifyChange() {
        if (onChange != null) {
            onChange.run();
        }
    }

    /** 每帧推进光标闪烁。 */
    void update(float dt) {
        Field f = activeField;
        if (f != null) {
            f.caretPhase = (f.caretPhase + dt) % 1f;
        }
    }

    /** 失焦 / 暂停：提交并收起键盘（避免键盘挂在后台）。 */
    void releaseAll() {
        commitActive();
    }

    /** 诊断摘要。 */
    String describe() {
        StringBuilder sb = new StringBuilder();
        for (Field f : fields) {
            if (sb.length() > 0) {
                sb.append(',');
            }
            sb.append(f.id).append('=').append(f.text);
            if (f.active) {
                sb.append("(active)");
            }
        }
        return sb.toString();
    }

    /**
     * 诊断：每个输入框的归一化矩形（0~1）。
     *
     * <p>用来回答「我点的地方到底有没有落在框上」：日志里同时给出触摸点的归一化坐标
     * 与每个框的 {@code nx/ny/nw/nh}，一比就知道是命中失败还是别的问题。
     */
    String describeRects() {
        StringBuilder sb = new StringBuilder();
        for (Field f : fields) {
            if (sb.length() > 0) {
                sb.append(' ');
            }
            sb.append(f.id).append("=[")
                    .append(fmt(f.nx)).append(',').append(fmt(f.ny)).append(' ')
                    .append(fmt(f.nw)).append('x').append(fmt(f.nh)).append(']');
        }
        return sb.toString();
    }

    private static String fmt(float v) {
        return String.valueOf(Math.round(v * 10000f) / 10000f);
    }
}
