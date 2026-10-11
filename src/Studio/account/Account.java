package Studio.account;

import java.util.UUID;

/** 一个账号。 */
public class Account {

    public String id = UUID.randomUUID().toString();
    public String email = "";
    public String displayName = "";
    /** PBKDF2 派生值，格式 salt:iterations:hash（Base64）。绝不存明文。 */
    public String passwordHash = "";
    public String plan = Plan.FREE.name();
    public long createdAt = System.currentTimeMillis();
    public long planExpiresAt = 0;
    /** 本机登录令牌（离线模式下用于免密续登）。 */
    public String token = UUID.randomUUID().toString();

    /** 远端账号 id：接上云端后填这里，本地仍保留这条记录。 */
    public String remoteId = "";

    public Plan planEnum() {
        try {
            return Plan.valueOf(plan);
        } catch (Exception e) {
            return Plan.FREE;
        }
    }

    public boolean planValid() {
        Plan p = planEnum();
        if (p == Plan.FREE) {
            return true;
        }
        return planExpiresAt == 0 || planExpiresAt > System.currentTimeMillis();
    }

    public String display() {
        if (displayName != null && !displayName.isEmpty()) {
            return displayName;
        }
        return email;
    }
}
