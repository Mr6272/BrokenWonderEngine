/**
 * 撤销快照的字符串池。
 *
 * 为什么需要它（实测数据，不是想象）：
 * 工程的素材可以是内联 base64（示例「扫雷」工程光素材就 4.76MB）。
 * 编辑器原来的撤销实现是 `JSON.stringify(store.project)`，按 80 步保留，
 * 每份快照都是 9.1MB 的**独立副本** —— 80 份 ≈ 731MB 堆常驻。
 * 表现就是「编辑器开的时间越长越卡」：堆一路涨，GC 越来越频繁、停顿越来越长，
 * 而用户只是拖了几下对象。
 *
 * 这里做的是「大字符串去重」：超过阈值的字符串在序列化时只留下一个短占位，
 * 真实内容在池里存**一份**（存的是原对象里的那个字符串引用，不复制）。
 * 反序列化时再按占位还原。快照因此从「每份 9.1MB」降到「每份几百 KB」。
 *
 * 约束：
 * - 占位用 \u0001 前缀（正常文案/路径/base64 里不会出现控制字符），
 *   且只在池内下标范围内解释，越界一律原样返回，不会把真实文本吃掉。
 * - 池总容量有上限；越过上限时整体重置，并由调用方丢弃过老的撤销历史，
 *   避免池自己变成新的泄漏点。
 */

/** 超过这个长度的字符串才进池。太短的值去重收益抵不过占位开销。 */
const BIG_STRING_MIN = 1024;

/** 占位前缀。用 \u0001 而不是常见字符，避免与真实数据冲突。 */
const TAG = "\u0001bwe:blob:";

/** 池内字符串总字节上限（按 UTF-16 字符数计）。越过就重置。 */
const MAX_POOL_CHARS = 64 * 1024 * 1024;

export class SnapshotPool {
  /** 内容 → 下标。键是**原工程里的字符串引用**，不会产生副本。 */
  private byContent = new Map<string, number>();
  /** 下标 → 内容 */
  private byId: string[] = [];
  /** 池内累计字符数 */
  private chars = 0;

  /**
   * 序列化。
   *
   * @param onOverflow 池满时的回调：调用方应当丢弃过老的撤销记录（那些占位已经还原不出来了）。
   */
  stringify(value: unknown, onOverflow?: () => void): string {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v !== "string" || v.length < BIG_STRING_MIN) return v;
      const hit = this.byContent.get(v);
      if (hit !== undefined) return TAG + hit;
      if (this.chars + v.length > MAX_POOL_CHARS) {
        // 池满了：主动清空并通知调用方丢弃过老的撤销记录。
        // 不能"这一次先不强留大串" —— 那样大串会退回每份快照各存一份，
        // 内存立刻打回原形（这正是在验证脚本里被抓到的行为）。
        this.clear();
        onOverflow?.();
      }
      const id = this.byId.length;
      this.byId.push(v);
      this.byContent.set(v, id);
      this.chars += v.length;
      return TAG + id;
    });
  }

  /** 反序列化：把占位还原成真实字符串。 */
  parse(json: string): unknown {
    return JSON.parse(json, (_key, v: unknown) => {
      if (typeof v !== "string" || !v.startsWith(TAG)) return v;
      const id = Number(v.slice(TAG.length));
      return Number.isInteger(id) && id >= 0 && id < this.byId.length ? this.byId[id] : v;
    });
  }

  /** 清空池。之后旧的占位再也还原不出来，调用方必须同时丢弃撤销历史。 */
  clear(): void {
    this.byContent.clear();
    this.byId.length = 0;
    this.chars = 0;
  }

  /** 诊断用：池内条目数与字符量。 */
  stats(): { entries: number; chars: number } {
    return { entries: this.byId.length, chars: this.chars };
  }
}
