package Studio.account;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import Studio.data.ProjectIO;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * 本机账号实现：账号表存在用户目录下，密码用 PBKDF2 加盐派生。
 *
 * 为什么现在就要做：用户要"为后续的账号登入、订阅计划做好接口"。
 * 光留空接口没法验证流程是否顺畅，所以这里做一个真的能注册/登录/换计划的本地实现，
 * 接后端时整个换掉这一个类即可。
 *
 * 安全口径：只存 salt 与派生值；不做"可逆加密"这种自欺欺人的处理。
 */
public final class LocalAuthProvider implements AuthProvider {

    private static final int ITER = 60000;
    private static final int KEYLEN = 256;
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

    private final Path store;

    public LocalAuthProvider() {
        String home = System.getProperty("user.home", ".");
        this.store = Path.of(home, ".bwe-studio", "accounts.json");
    }

    private List<Account> load() {
        try {
            if (!Files.exists(store)) {
                return new ArrayList<>();
            }
            String json = Files.readString(store, StandardCharsets.UTF_8);
            List<Account> list = GSON.fromJson(json, new TypeToken<List<Account>>() {
            }.getType());
            return list == null ? new ArrayList<>() : list;
        } catch (Exception e) {
            return new ArrayList<>();
        }
    }

    private void persist(List<Account> list) throws IOException {
        Files.createDirectories(store.getParent());
        Files.writeString(store, GSON.toJson(list), StandardCharsets.UTF_8);
    }

    @Override
    public Result register(String email, String password, String displayName) {
        email = norm(email);
        if (!looksLikeEmail(email)) {
            return Result.fail("邮箱格式看起来不对，检查一下再试");
        }
        if (password == null || password.length() < 6) {
            return Result.fail("密码至少 6 位");
        }
        List<Account> list = load();
        for (Account a : list) {
            if (a.email.equalsIgnoreCase(email)) {
                return Result.fail("这个邮箱已经注册过了，直接登录吧");
            }
        }
        Account a = new Account();
        a.email = email;
        a.displayName = displayName == null || displayName.isBlank() ? email.substring(0, email.indexOf('@')) : displayName.trim();
        a.passwordHash = hash(password);
        a.plan = Plan.FREE.name();
        list.add(a);
        try {
            persist(list);
        } catch (IOException e) {
            return Result.fail("账号没存住：" + e.getMessage());
        }
        return Result.ok(a);
    }

    @Override
    public Result login(String email, String password) {
        email = norm(email);
        List<Account> list = load();
        for (Account a : list) {
            if (a.email.equalsIgnoreCase(email)) {
                if (verify(password, a.passwordHash)) {
                    return Result.ok(a);
                }
                return Result.fail("密码不对");
            }
        }
        return Result.fail("没有这个账号，先去注册");
    }

    @Override
    public Result resume(String token) {
        if (token == null || token.isEmpty()) {
            return Result.fail("没有可续登的登录状态");
        }
        for (Account a : load()) {
            if (token.equals(a.token)) {
                return Result.ok(a);
            }
        }
        return Result.fail("登录状态已失效，请重新登录");
    }

    @Override
    public void logout() {
        // 本地实现只在内存里清状态，账号表保留（用户下次还能登）
    }

    @Override
    public boolean verifyPlan(Account a) {
        return a != null && a.planValid();
    }

    @Override
    public boolean isRemote() {
        return false;
    }

    /** 本地实现下"升级计划"直接生效，接后端时这里会变成下单流程。 */
    public boolean switchPlan(Account a, Plan p) {
        List<Account> list = load();
        for (Account it : list) {
            if (it.id.equals(a.id)) {
                it.plan = p.name();
                it.planExpiresAt = p == Plan.FREE ? 0 : System.currentTimeMillis() + 30L * 24 * 3600 * 1000;
                a.plan = it.plan;
                a.planExpiresAt = it.planExpiresAt;
                try {
                    persist(list);
                } catch (IOException e) {
                    return false;
                }
                return true;
            }
        }
        return false;
    }

    // ---------------- 密码 ----------------

    private static String hash(String pw) {
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        byte[] key = derive(pw, salt, ITER);
        return Base64.getEncoder().encodeToString(salt) + ":" + ITER + ":" + Base64.getEncoder().encodeToString(key);
    }

    private static boolean verify(String pw, String stored) {
        if (stored == null || stored.isEmpty() || pw == null) {
            return false;
        }
        String[] parts = stored.split(":");
        if (parts.length != 3) {
            return false;
        }
        try {
            byte[] salt = Base64.getDecoder().decode(parts[0]);
            int iter = Integer.parseInt(parts[1]);
            byte[] expect = Base64.getDecoder().decode(parts[2]);
            byte[] got = derive(pw, salt, iter);
            if (got.length != expect.length) {
                return false;
            }
            int diff = 0;
            for (int i = 0; i < got.length; i++) {
                diff |= got[i] ^ expect[i];
            }
            return diff == 0;
        } catch (Exception e) {
            return false;
        }
    }

    private static byte[] derive(String pw, byte[] salt, int iter) {
        try {
            PBEKeySpec spec = new PBEKeySpec(pw.toCharArray(), salt, iter, KEYLEN);
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } catch (Exception e) {
            throw new IllegalStateException("密码派生失败", e);
        }
    }

    private static String norm(String s) {
        return s == null ? "" : s.trim();
    }

    private static boolean looksLikeEmail(String s) {
        int at = s.indexOf('@');
        return at > 0 && at < s.length() - 3 && s.indexOf('.', at) > at + 1 && !s.contains(" ");
    }
}
