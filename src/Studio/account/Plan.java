package Studio.account;

import java.util.ArrayList;
import java.util.List;

/**
 * 订阅计划。
 *
 * 这里定义的是"功能门禁"的最小集合：编辑器在渲染模块库与导出时读它，
 * 而不是散布在各处的 if。后续接上真实计费后端时，只需替换 Session 的实现，
 * 这套枚举与可以使用的判断逻辑保持不变。
 */
public enum Plan {

    FREE("免费版", 0,
            "个人试用与学习",
            new String[]{"全部地图编辑功能", "全部基础模块", "剧本编辑", "导出关卡 JSON"}),

    INDIE("独立开发者", 68,
            "打算上架卖的小团队",
            new String[]{"免费版全部功能", "高级战斗与 AI 模块", "规则包导出与分享",
                    "多场景批量导出", "工程模板库"}),

    STUDIO("工作室", 198,
            "多人协作的工作室",
            new String[]{"独立开发者全部功能", "团队素材库与共享规则包",
                    "云端备份与版本历史", "优先技术支持"});

    public final String cn;
    public final int monthlyYuan;
    public final String who;
    public final String[] includes;

    Plan(String cn, int monthlyYuan, String who, String[] includes) {
        this.cn = cn;
        this.monthlyYuan = monthlyYuan;
        this.who = who;
        this.includes = includes;
    }

    public boolean atLeast(Plan other) {
        return ordinal() >= other.ordinal();
    }

    public List<String> includesList() {
        List<String> l = new ArrayList<>();
        for (String s : includes) {
            l.add(s);
        }
        return l;
    }

    public String priceText() {
        return monthlyYuan == 0 ? "免费" : monthlyYuan + " 元 / 月";
    }

    @Override
    public String toString() {
        return cn;
    }
}
