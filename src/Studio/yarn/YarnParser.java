package Studio.yarn;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Yarn Spinner 剧本解析器（只读分析，不执行）。
 *
 * 为什么自己做而不是找现成库：Yarn Spinner 官方实现是 C#，Java 侧没有可靠的对应实现，
 * 而本项目需要的只是「结构索引 + 语法检查」，用于编辑器中的节点导航与错误提示。
 * 剧本原文始终按 Yarn 规范保存，编辑器不引入私有语法，将来可以直接交给任何 Yarn 运行时执行。
 *
 * 支持的语法（Yarn Spinner 1.x 子集）：
 *   title: 节点名 / --- / ===
 *   -> 选项（含条件选项 -> 文本 <<if ...>>）
 *   <<jump 节点>>  <<stop>>  <<set $var = 值>>  <<if>> <<elseif>> <<else>> <<endif>>
 *   注释 // 与 #line: 标签
 */
public final class YarnParser {

    /** 一个节点。 */
    public static final class Node {
        public String title = "";
        public int line;
        public int endLine;
        public final List<Choice> choices = new ArrayList<>();
        public final List<String> jumps = new ArrayList<>();
        public final Set<String> setsVars = new LinkedHashSet<>();
        public final Set<String> readsVars = new LinkedHashSet<>();
        /** 节点里出现的说话人（"名字: 台词" 形式）。 */
        public final Set<String> speakers = new LinkedHashSet<>();
        public final List<Issue> issues = new ArrayList<>();

        public int lineCount() {
            return Math.max(1, endLine - line + 1);
        }
    }

    /** 一个选项分支。 */
    public static final class Choice {
        public String text = "";
        public String condition = "";
        public int line;
    }

    public static final class Issue {
        public final String message;
        public final int line;
        public final boolean error;

        public Issue(String message, int line, boolean error) {
            this.message = message;
            this.line = line;
            this.error = error;
        }
    }

    public static final class Result {
        public final List<Node> nodes = new ArrayList<>();
        public final List<Issue> issues = new ArrayList<>();
        public final Map<String, Node> byTitle = new LinkedHashMap<>();
        /** 所有节点里出现的变量名。 */
        public final Set<String> variables = new LinkedHashSet<>();

        public Node node(String title) {
            return byTitle.get(title);
        }

        public int errorCount() {
            int n = 0;
            for (Issue i : issues) {
                if (i.error) {
                    n++;
                }
            }
            return n;
        }
    }

    private static final Pattern TITLE = Pattern.compile("^\\s*title\\s*:\\s*(.+?)\\s*$");
    private static final Pattern CHOICE = Pattern.compile("^\\s*->\\s*(.*)$");
    private static final Pattern JUMP = Pattern.compile("<<\\s*jump\\s+([^>]+?)\\s*>>");
    private static final Pattern SET = Pattern.compile("<<\\s*set\\s+\\$([A-Za-z_\\u4e00-\\u9fa5][\\w\\u4e00-\\u9fa5]*)\\s*=");
    private static final Pattern VAR = Pattern.compile("\\$([A-Za-z_\\u4e00-\\u9fa5][\\w\\u4e00-\\u9fa5]*)");
    private static final Pattern IF_OPEN = Pattern.compile("<<\\s*if\\b");
    private static final Pattern IF_CLOSE = Pattern.compile("<<\\s*endif\\s*>>");
    private static final Pattern LINE_TAG = Pattern.compile("#line:\\s*([0-9a-fA-F]+)");
    private static final Pattern SPEAKER = Pattern.compile("^\\s*([^:\\-<>#\\s][^:]{0,17})\\s*:\\s*\\S");

    private YarnParser() {
    }

    public static Result parse(String source) {
        Result r = new Result();
        ParseState state = new ParseState();
        if (source == null || source.isBlank()) {
            r.issues.add(new Issue("剧本是空的。至少写一个节点，开头是 title: 名字", 1, false));
            return r;
        }
        String[] lines = source.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);

        int i = 0;
        Node cur = null;
        int bodyStart = -1;

        // 找 title: 行与 --- / === 的分界
        while (i < lines.length) {
            String raw = lines[i];
            String line = stripComment(raw).trim();
            if (line.isEmpty()) {
                i++;
                continue;
            }
            Matcher tm = TITLE.matcher(line);
            if (tm.matches()) {
                if (cur != null) {
                    cur.endLine = i; // 上一个节点结束
                }
                cur = new Node();
                cur.title = tm.group(1).trim();
                cur.line = i + 1;
                if (cur.title.isEmpty()) {
                    r.issues.add(new Issue("第 " + (i + 1) + " 行的节点没有名字", i + 1, true));
                } else if (r.byTitle.containsKey(cur.title)) {
                    r.issues.add(new Issue("节点名「" + cur.title + "」重复了，运行时只有一个能用", i + 1, true));
                } else {
                    r.byTitle.put(cur.title, cur);
                }
                r.nodes.add(cur);
                bodyStart = -1;
                i++;
                continue;
            }
            if (line.equals("---")) {
                bodyStart = i;
                i++;
                continue;
            }
            if (line.equals("===")) {
                if (cur == null) {
                    r.issues.add(new Issue("第 " + (i + 1) + " 行出现了 === 但没有对应的节点（缺 title:）", i + 1, true));
                } else {
                    cur.endLine = i + 1;
                    cur = null;
                }
                i++;
                continue;
            }
            if (cur != null && bodyStart >= 0) {
                parseBodyLine(cur, line, i + 1, r, state);
            } else if (cur != null && bodyStart < 0) {
                if (!line.startsWith("#") && !line.startsWith("tags:") && !line.startsWith("position:")) {
                    r.issues.add(new Issue("第 " + (i + 1) + " 行在 --- 之前，运行时会被当成节点属性忽略", i + 1, false));
                }
            } else if (line.startsWith("->") || line.startsWith("<<")) {
                r.issues.add(new Issue("第 " + (i + 1) + " 行的内容不在任何节点里，请先写 title: 并用 --- 开始正文",
                        i + 1, true));
            }
            i++;
        }
        if (cur != null && cur.endLine == 0) {
            cur.endLine = lines.length;
            r.issues.add(new Issue("节点「" + cur.title + "」没有用 === 收尾，剧本可能被截断", cur.line, true));
        }
        if (r.nodes.isEmpty()) {
            r.issues.add(new Issue("没有找到任何节点。一个节点长这样：\ntitle: 开场\n---\n旁白: 你好\n===", 1, true));
        }

        checkJumps(r);
        for (Node n : r.nodes) {
            r.variables.addAll(n.setsVars);
            r.variables.addAll(n.readsVars);
        }
        return r;
    }

    private static void parseBodyLine(Node n, String line, int lineNo, Result r, ParseState state) {
        // 控制流括号配对
        if (IF_OPEN.matcher(line).find() && !line.contains("endif")) {
            state.pairing++;
        }
        if (IF_CLOSE.matcher(line).find()) {
            if (state.pairing > 0) {
                state.pairing--;
            } else {
                r.issues.add(new Issue("第 " + lineNo + " 行有一个多余的 <<endif>>", lineNo, true));
            }
        }

        Matcher cm = CHOICE.matcher(line);
        if (cm.matches()) {
            String rest = cm.group(1).trim();
            Choice ch = new Choice();
            ch.line = lineNo;
            // 条件选项：-> 文本 <<if $a == 1>>
            Matcher cond = Pattern.compile("<<\\s*if\\s+(.+?)>>").matcher(rest);
            if (cond.find()) {
                ch.condition = cond.group(1).trim();
                rest = rest.substring(0, cond.start()).trim();
                for (String v : vars(cond.group(1))) {
                    n.readsVars.add(v);
                }
            }
            ch.text = rest;
            if (ch.text.isEmpty()) {
                r.issues.add(new Issue("第 " + lineNo + " 行的选项没有文字，玩家会看到一行空白", lineNo, false));
            }
            n.choices.add(ch);
        }

        Matcher jm = JUMP.matcher(line);
        while (jm.find()) {
            String t = jm.group(1).trim();
            if (!t.isEmpty()) {
                n.jumps.add(t);
            }
        }
        if (line.contains("<<stop>>") || line.contains("<<stop >>")) {
            n.jumps.add("（结束）");
        }

        Matcher sm = SET.matcher(line);
        if (sm.find()) {
            n.setsVars.add(sm.group(1));
        }
        for (String v : vars(line)) {
            if (!n.setsVars.contains(v)) {
                n.readsVars.add(v);
            }
        }

        if (line.contains("<<") && !line.contains(">>")) {
            r.issues.add(new Issue("第 " + lineNo + " 行的命令少了 >> 收尾", lineNo, true));
        }

        Matcher sp = SPEAKER.matcher(line);
        if (sp.find()) {
            String name = sp.group(1).trim();
            if (!name.isEmpty() && !name.startsWith("<<") && !name.startsWith("->")) {
                n.speakers.add(name);
            }
        }
        if (line.startsWith("<<") && IF_OPEN.matcher(line).find() && !line.contains(">>")) {
            r.issues.add(new Issue("第 " + lineNo + " 行的 <<if 少了 >>", lineNo, true));
        }
    }

    /** 解析过程中的临时状态。用具名对象承载，避免把状态挂在类的静态字段上。 */
    private static final class ParseState {
        int pairing;
    }

    private static void checkJumps(Result r) {
        for (Node n : r.nodes) {
            for (String j : n.jumps) {
                if (j.equals("（结束）")) {
                    continue;
                }
                if (!r.byTitle.containsKey(j)) {
                    n.issues.add(new Issue("跳到「" + j + "」，但没有这个节点", n.line, true));
                    r.issues.add(new Issue("第 " + n.line + " 行的节点「" + n.title + "」跳到了不存在的「" + j + "」",
                            n.line, true));
                }
            }
        }
        // 孤立节点：没人跳进来，也不是第一个
        if (r.nodes.size() > 1) {
            for (int i = 1; i < r.nodes.size(); i++) {
                Node n = r.nodes.get(i);
                boolean referenced = false;
                for (Node other : r.nodes) {
                    if (other != n && other.jumps.contains(n.title)) {
                        referenced = true;
                        break;
                    }
                }
                if (!referenced) {
                    r.issues.add(new Issue("节点「" + n.title + "」没有任何地方跳进来，玩家看不到它",
                            n.line, false));
                }
            }
        }
    }

    private static String stripComment(String line) {
        int i = line.indexOf("//");
        return i < 0 ? line : line.substring(0, i);
    }

    private static List<String> vars(String s) {
        List<String> out = new ArrayList<>();
        Matcher m = VAR.matcher(s == null ? "" : s);
        while (m.find()) {
            out.add(m.group(1));
        }
        return out;
    }

    /** 生成一个新节点骨架，供"插入节点"按钮使用。 */
    public static String newNodeSnippet(String title) {
        return "\ntitle: " + title + "\n---\n旁白: 这里写第一句话\n===\n";
    }

    /** 统计剧本规模，用于列表里的一行摘要。 */
    public static String summarize(Result r) {
        if (r.nodes.isEmpty()) {
            return "还没有节点";
        }
        int choices = 0;
        for (Node n : r.nodes) {
            choices += n.choices.size();
        }
        String base = r.nodes.size() + " 个节点　·　" + choices + " 个选项";
        int err = r.errorCount();
        return err > 0 ? base + "　·　" + err + " 处要改" : base;
    }

}
