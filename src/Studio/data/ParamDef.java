package Studio.data;

import java.util.ArrayList;
import java.util.List;

/**
 * 模块参数定义。这是"无代码"的关键：用户永远只填值，不写表达式。
 * 所有能给默认值的都必须给默认值 —— 拖进场景即可运行，用户再按需微调。
 */
public class ParamDef {

    public String key;
    /** 界面上显示的名字，用大白话，如"走多快"。 */
    public String label;
    public ParamType type = ParamType.TEXT;
    public String def = "";
    /** PICK 型：可选值。 */
    public List<String> options = new ArrayList<>();
    /** NUM 型：最小值/最大值/步进，决定控件是否滑杆。 */
    public float min = 0;
    public float max = 0;
    public float step = 1;
    /** 数值单位，如 "像素/秒"、"秒"、"格"。 */
    public String unit = "";
    /** 悬浮提示：这一栏到底在问什么，一句话说清。 */
    public String hint = "";
    /** 是否必填。非必填留空即表示"不做这件事"。 */
    public boolean required = false;

    public ParamDef() {
    }

    public static ParamDef num(String key, String label, float def, float min, float max, String unit, String hint) {
        ParamDef p = new ParamDef();
        p.key = key;
        p.label = label;
        p.type = ParamType.NUM;
        p.def = trim(def);
        p.min = min;
        p.max = max;
        p.step = (max - min) <= 20 ? 0.5f : 1f;
        p.unit = unit;
        p.hint = hint;
        return p;
    }

    public static ParamDef text(String key, String label, String def, String hint) {
        ParamDef p = new ParamDef();
        p.key = key;
        p.label = label;
        p.type = ParamType.TEXT;
        p.def = def;
        p.hint = hint;
        return p;
    }

    public static ParamDef bool(String key, String label, boolean def, String hint) {
        ParamDef p = new ParamDef();
        p.key = key;
        p.label = label;
        p.type = ParamType.BOOL;
        p.def = def ? "开" : "关";
        p.hint = hint;
        return p;
    }

    public static ParamDef pick(String key, String label, String def, String hint, String... options) {
        ParamDef p = new ParamDef();
        p.key = key;
        p.label = label;
        p.type = ParamType.PICK;
        p.def = def;
        p.hint = hint;
        for (String o : options) {
            p.options.add(o);
        }
        return p;
    }

    public static ParamDef ref(String key, String label, ParamType type, String hint) {
        ParamDef p = new ParamDef();
        p.key = key;
        p.label = label;
        p.type = type;
        p.def = "";
        p.hint = hint;
        return p;
    }

    public static ParamDef note(String text) {
        ParamDef p = new ParamDef();
        p.key = "__note_" + Math.abs(text.hashCode());
        p.label = text;
        p.type = ParamType.NOTE;
        return p;
    }

    /** 数值转字符串时去掉多余的 .0，让默认值读起来干净。 */
    static String trim(float v) {
        if (v == Math.round(v)) {
            return String.valueOf(Math.round(v));
        }
        return String.valueOf(v);
    }
}
