package Studio.account;

/**
 * 账号服务的抽象接口。
 *
 * 存在的理由：编辑器逻辑只依赖这个接口，本地实现（LocalAuthProvider）现在就能跑，
 * 将来接上真实后端时新增一个 HttpAuthProvider 即可，不用改动任何界面代码。
 *
 * 约定的错误处理：不抛异常表示成功；抛 AuthException 携带一句可直接显示给用户的中文。
 */
public interface AuthProvider {

    /** 结果对象：成功时带账号，失败时 message 是给用户看的人话。 */
    final class Result {
        public final boolean ok;
        public final Account account;
        public final String message;

        private Result(boolean ok, Account account, String message) {
            this.ok = ok;
            this.account = account;
            this.message = message;
        }

        public static Result ok(Account a) {
            return new Result(true, a, "");
        }

        public static Result fail(String msg) {
            return new Result(false, null, msg);
        }
    }

    /** 注册。 */
    Result register(String email, String password, String displayName);

    /** 登录。 */
    Result login(String email, String password);

    /** 用保存的令牌免密续登（离线打开工程时用）。 */
    Result resume(String token);

    /** 退出登录（清本机令牌）。 */
    void logout();

    /** 查询当前订阅计划是否仍然有效。 */
    boolean verifyPlan(Account a);

    /** 该服务是否需要联网。界面据此决定是否提示"离线可用"。 */
    boolean isRemote();
}
