package Studio.data;

import java.util.ArrayList;
import java.util.List;

/**
 * 模块定义（积木的"形状说明"）。
 * 全部内置模块在 {@code Studio.modules.BuiltinModules} 中集中注册，这里是纯数据。
 */
public class ModuleDef {

    public String id;
    /** 积木上显示的名字，例如"朝玩家走"。 */
    public String title;
    public ModuleCategory category = ModuleCategory.MOVE;
    /** 一行说明：它会做什么。 */
    public String blurb = "";
    /** 展开后的详细说明：什么时候不该用、和其他模块怎么配合。 */
    public String detail = "";
    public List<ParamDef> params = new ArrayList<>();
    /** 允许的触发时机；空列表表示"立刻生效"。 */
    public List<Trigger> triggers = new ArrayList<>();

    /** 实验性模块：界面会标灰并提示"可能还会变"。 */
    public boolean experimental = false;
    /** 需要订阅才能使用的模块（预留给后续商业化）。 */
    public boolean premium = false;

    public ParamDef param(String key) {
        for (ParamDef p : params) {
            if (p.key.equals(key)) {
                return p;
            }
        }
        return null;
    }

    public Trigger defaultTrigger() {
        return triggers.isEmpty() ? Trigger.ALWAYS : triggers.get(0);
    }

    /** 一行摘要，用于积木卡片收起状态显示。 */
    public String summary(ModuleInstance inst) {
        if (params.isEmpty()) {
            return blurb.isEmpty() ? title : blurb;
        }
        StringBuilder sb = new StringBuilder();
        for (ParamDef d : params) {
            if (d.type == ParamType.NOTE) {
                continue;
            }
            String v = inst.value(d.key, d.def);
            if (v == null || v.isEmpty()) {
                continue;
            }
            ParamType t = d.type;
            if (t == ParamType.OBJ || t == ParamType.ASSET || t == ParamType.TAG || t == ParamType.SCRIPT) {
                v = "…" + shortId(v);
            }
            if (sb.length() > 0) {
                sb.append(" · ");
            }
            sb.append(d.label).append(' ').append(v);
            if (sb.length() > 46) {
                sb.append(" …");
                break;
            }
        }
        return sb.length() == 0 ? (blurb.isEmpty() ? title : blurb) : sb.toString();
    }

    private static String shortId(String id) {
        String clean = id.startsWith("@") ? id.substring(1) : id;
        return clean.length() > 6 ? clean.substring(0, 6) : clean;
    }
}
