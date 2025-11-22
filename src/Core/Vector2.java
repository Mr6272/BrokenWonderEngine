package Core;

public class Vector2 {

    public Vector2(float x, float y)
    {
        this.x = x;
        this.y = y;
    }
    public float x;
    public float y;

    public Vector2 DeepCopy()
    {
        return new Vector2(x, y);
    }

    /// 测距离方法
    public static float Distance(Vector2 a, Vector2 b) {
        if (a == null || b == null) {
            throw new IllegalArgumentException("Vector2.Distance 的参数不能为 null");
        }

        float dx = a.x - b.x;
        float dy = a.y - b.y;
        return (float)Math.sqrt(dx * dx + dy * dy);
    }

    // ================== 模长 ==================
    // 计算当前向量的模长（长度）
    public float Magnitude() {
        return (float)Math.sqrt(x * x + y * y);
    }

    // 如果你想要平方长度（有时候不用开根号省点性能）
    public float MagnitudeSquared() {
        return x * x + y * y;
    }

    // ================== 标准化 ==================
    // 返回一个“标准化后的新向量”，不改自己
    public Vector2 Normalized() {
        float mag = Magnitude();
        if (mag == 0f) {
            // 零向量没法标准化，这里直接返回一个(0,0)
            return new Vector2(0f, 0f);
        }
        return new Vector2(x / mag, y / mag);
    }

    // 原地标准化：把自己变成单位向量
    public void Normalize() {
        float mag = Magnitude();
        if (mag == 0f) {
            // 零向量，直接不动
            return;
        }
        x /= mag;
        y /= mag;
    }

    public String ToString()
    {
        return "Vector2(" + x + ", " + y + ")";
    }
}
