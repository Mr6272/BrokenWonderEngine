package Studio.data;

import java.util.ArrayList;
import java.util.List;

/** 一份 Yarn 剧本：原文 + 解析出来的节点索引（索引只缓存，改了原文自动重算）。 */
public class YarnScript {

    /** 脚本逻辑名，如"序章"。 */
    public String name = "新剧本";
    /** 磁盘文件名（相对工程根），保存时用。 */
    public String file = "";
    /** Yarn Spinner 原文，一字不改地保存。 */
    public String source = "";

    /** 解析缓存：节点名列表。 */
    public List<String> nodeCache = new ArrayList<>();
    /** 上次解析时原文的哈希，用于判断缓存是否过期。 */
    public int parsedHash = 0;

    public YarnScript() {
    }

    public YarnScript(String name, String source) {
        this.name = name;
        this.source = source;
        this.file = "Scripts/" + name + ".yarn";
    }

    /** 语料库自带的最小可用模板：新工程开箱就有东西可跑，不是空白。 */
    public static String starterSource() {
        return """
                title: 序章
                ---
                旁白: 夜色压下来，风把火把吹得东倒西歪。
                旅人: 这地方……三年前就该没人了。
                -> 推门进去
                    旁白: 门轴发出一声长叹。
                    <<jump 门内>>
                -> 转身离开
                    旁白: 你决定不惹麻烦。
                    <<stop>>
                ===

                title: 门内
                ---
                旁白: 屋里点着一盏灯。
                <<if $问过路了>>
                    老人: 你回来了。
                <<else>>
                    老人: 谁在外面？
                    <<set $问过路了 = true>>
                <<endif>>
                ===
                """;
    }
}
