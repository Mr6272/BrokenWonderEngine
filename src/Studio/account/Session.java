package Studio.account;

import Studio.ui.Toast;

/**
 * 登录状态与权限的唯一入口。
 *
 * 编辑器其它地方只允许问这两个问题：
 *   Session.get().plan()       —— 现在是什么计划
 *   Session.get().can(Plan.X)  —— 能不能用某个需要付费的能力
 * 不允许在业务代码里散落账号判断。
 *
 * 换后端：调用 setProvider(new HttpAuthProvider(...)) 即可，其余代码零改动。
 */
public final class Session {

    private static final Session INSTANCE = new Session();

    private AuthProvider provider = new LocalAuthProvider();
    private Account account;

    private Session() {
        // 启动时尝试用本机令牌免密续登，失败就当未登录 —— 不打扰用户
        try {
            String token = loadToken();
            if (token != null && !token.isEmpty()) {
                AuthProvider.Result r = provider.resume(token);
                if (r.ok) {
                    account = r.account;
                }
            }
        } catch (Exception ignored) {
        }
    }

    public static Session get() {
        return INSTANCE;
    }

    /** 切换账号后端（接云端时用）。 */
    public void setProvider(AuthProvider p) {
        if (p != null) {
            provider = p;
        }
    }

    public AuthProvider provider() {
        return provider;
    }

    public boolean loggedIn() {
        return account != null;
    }

    public Account account() {
        return account;
    }

    public Plan plan() {
        return account == null ? Plan.FREE : account.planEnum();
    }

    /** 能力门禁：模块与导出功能据此决定是否可用。 */
    public boolean can(Plan needed) {
        return plan().atLeast(needed);
    }

    public String planLabel() {
        return loggedIn() ? account.display() + "　·　" + plan().cn : "未登录";
    }

    void adopt(Account a) {
        account = a;
        saveToken(a == null ? "" : a.token);
    }

    public void logout() {
        provider.logout();
        account = null;
        saveToken("");
    }

    public boolean switchPlan(Plan p) {
        if (account == null) {
            Toast.warn("先登录再改计划");
            return false;
        }
        if (provider instanceof LocalAuthProvider la) {
            if (la.switchPlan(account, p)) {
                return true;
            }
            Toast.error("计划没改成功");
            return false;
        }
        Toast.info("当前账号由云端管理，请在订阅页面修改");
        return false;
    }

    public void openLoginDialog(java.awt.Window owner) {
        AccountDialogs.showLogin(owner);
    }

    public void openPlansDialog(java.awt.Window owner) {
        if (!loggedIn()) {
            Toast.info("先登录，之后可以在这里挑计划");
            AccountDialogs.showLogin(owner);
            return;
        }
        AccountDialogs.showPlans(owner);
    }

    // ---------------- 令牌持久化 ----------------

    private static java.nio.file.Path tokenFile() {
        return java.nio.file.Path.of(System.getProperty("user.home", "."), ".bwe-studio", "session.token");
    }

    private static String loadToken() {
        try {
            java.nio.file.Path p = tokenFile();
            return java.nio.file.Files.exists(p)
                    ? java.nio.file.Files.readString(p, java.nio.charset.StandardCharsets.UTF_8).trim()
                    : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static void saveToken(String token) {
        try {
            java.nio.file.Path p = tokenFile();
            java.nio.file.Files.createDirectories(p.getParent());
            java.nio.file.Files.writeString(p, token == null ? "" : token,
                    java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception ignored) {
        }
    }
}
