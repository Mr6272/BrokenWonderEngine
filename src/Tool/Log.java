package Tool;

public final class Log {

    // 是否启用日志（方便上线关掉）
    private static final boolean ENABLED = true;
    private static final String TAG = "[BrokenWonder]";

    private Log() {}

    public static void d(String msg) {
        log("D", msg, null);
    }

    public static void i(String msg) {
        log("I", msg, null);
    }

    public static void w(String msg) {
        log("W", msg, null);
    }

    public static void e(String msg) {
        log("E", msg, null);
    }

    public static void e(String msg, Throwable t) {
        log("E", msg, t);
    }

    private static void log(String level, String msg, Throwable t) {
        if (!ENABLED) return;

        StackTraceElement caller = findCaller();
        String loc = "";
        if (caller != null) {
            String className = caller.getClassName();
            // 简化成短类名
            int dot = className.lastIndexOf('.');
            if (dot != -1) {
                className = className.substring(dot + 1);
            }
            loc = className + ":" + caller.getLineNumber();
        }

        String out = String.format("%s %s %-20s | %s", TAG, level, loc, msg);
        System.out.println(out);

        if (t != null) {
            t.printStackTrace(System.out);
        }
    }

    private static StackTraceElement findCaller() {
        StackTraceElement[] stack = Thread.currentThread().getStackTrace();
        String logClassName = Log.class.getName();

        boolean foundSelf = false;
        for (StackTraceElement element : stack) {
            String cn = element.getClassName();

            // 先找到自己（Log），然后下一次不是自己的就当作调用者
            if (cn.equals(logClassName)) {
                foundSelf = true;
                continue;
            }

            if (foundSelf) {
                // 排掉 Thread 之类的噪音
                if (!cn.startsWith("java.lang.Thread")) {
                    return element;
                }
            }
        }
        // 兜底：万一没找到就返回栈顶
        return stack.length > 0 ? stack[stack.length - 1] : null;
    }
}
