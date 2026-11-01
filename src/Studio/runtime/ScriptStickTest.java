package Studio.runtime;

/**
 * 虚拟摇杆（{@code bwe.stick}）自检。
 *
 * <p>为什么需要：摇杆是「触摸 → 引擎状态」的桥梁，很容易出现「看起来画出来了，
 * 但按键状态没同步 / 触摸没被消费 / 摇杆轴永远是 0」这类静默失败。
 * 这里直接驱动 {@link ScriptStick} 的触摸入口，断言四件事：
 * <ol>
 *   <li>mount 后布局里有预期的按键，且默认不挂十字摇杆时也能正确计数；</li>
 *   <li>按下按键 → 消费触摸（返回 true）+ 对应键码置位；</li>
 *   <li>双指摇杆 → 轴值落在 (-1..1)，且超过半径时被钳制；</li>
 *   <li>抬起/失焦 → 所有键码归零（不能「按键卡住」）。</li>
 * </ol>
 */
public final class ScriptStickTest {

    private static int pass;
    private static int fail;

    public static void main(String[] args) {
        try {
            testMountLayout();
            testButtonPress();
            testAnalogAxis();
            testReleaseAll();
        } catch (Throwable t) {
            fail++;
            System.out.println("异常: " + t);
            t.printStackTrace(System.out);
        }
        System.out.println("==== RESULT: " + pass + "/" + (pass + fail) + " passed ====");
        if (fail > 0) {
            System.out.println(fail + " 项失败");
            System.exit(1);
        }
        System.out.println("ALL PASS");
    }

    private static void check(String name, boolean ok) {
        if (ok) {
            pass++;
            System.out.println("  [PASS] " + name);
        } else {
            fail++;
            System.out.println("  [FAIL] " + name);
        }
    }

    /** 造一个最小宿主：只需要 view 尺寸和 keys 数组。 */
    private static TopDownRuntime hostStub() {
        TopDownRuntime rt = TopDownRuntime.newStub();
        rt.view.setViewport(1280, 720);
        return rt;
    }

    private static void testMountLayout() {
        TopDownRuntime rt = hostStub();
        ScriptStick s = new ScriptStick(rt);
        s.mount("space,enter,tab,esc");
        check("mount 4 键 → 4 个控件", s.controls().size() == 4);
        check("mount 后 mounted=true", s.isMounted());
        check("无 analog 控件", s.controls().stream().noneMatch(c -> c.analog));

        ScriptStick s2 = new ScriptStick(rt);
        s2.mount("WASD,space");
        check("WASD+space → 2 个控件", s2.controls().size() == 2);
        check("WASD 是 analog", s2.controls().get(0).analog);

        ScriptStick s3 = new ScriptStick(rt);
        s3.mount("");
        check("空串用默认布局（5 项）", s3.controls().size() == 5);
    }

    private static void testButtonPress() {
        TopDownRuntime rt = hostStub();
        ScriptStick s = new ScriptStick(rt);
        s.mount("space,enter,tab,esc");
        ScriptStick.Control space = s.controls().get(0);
        // 取按键中心（归一化 → 逻辑像素）
        float nx = space.nx + space.nw / 2f;
        float ny = space.ny + space.nh / 2f;
        float lx = nx * 1280, ly = ny * 720;

        int spaceCode = java.awt.event.KeyEvent.VK_SPACE;
        check("按下前 space 为 false", !rt.keys[spaceCode]);
        boolean consumed = s.pointerDown(0, lx, ly);
        check("按下后触摸被消费", consumed);
        check("按下后 space 置位", rt.keys[spaceCode]);
        check("按下后 pressed=true", space.pressed);

        s.pointerUp(0);
        check("抬起后 space 归零", !rt.keys[spaceCode]);
        check("抬起后 pressed=false", !space.pressed);

        // 点在空白处 → 不消费
        check("空白处按下不消费", !s.pointerDown(1, 640f, 100f));
    }

    private static void testAnalogAxis() {
        TopDownRuntime rt = hostStub();
        ScriptStick s = new ScriptStick(rt);
        s.mount("WASD,space");
        ScriptStick.Control cross = s.controls().get(0);

        // 按在中心偏右 → axisX > 0，且 D 键置位
        float lx = (cross.cxN + cross.radiusN * 0.6f) * 1280;
        float ly = cross.cyN * 720;
        s.pointerDown(0, lx, ly);
        float[] a = s.axis();
        check("摇杆右推 axisX > 0.3", a[0] > 0.3f);
        check("D 键置位", rt.keys[java.awt.event.KeyEvent.VK_D]);
        check("W 未置位", !rt.keys[java.awt.event.KeyEvent.VK_W]);

        // 推到很远处 → 轴值被钳到 1 以内
        s.pointerMove(0, (cross.cxN + cross.radiusN * 5f) * 1280, cross.cyN * 720);
        float[] a2 = s.axis();
        check("超范围后 axisX 仍 <= 1", a2[0] <= 1.0001f);

        // 回中心（死区内）→ 轴归零
        s.pointerMove(0, cross.cxN * 1280, cross.cyN * 720);
        float[] a3 = s.axis();
        check("回中心轴归零", Math.abs(a3[0]) < 0.01f && Math.abs(a3[1]) < 0.01f);

        s.releaseAll();
    }

    private static void testReleaseAll() {
        TopDownRuntime rt = hostStub();
        ScriptStick s = new ScriptStick(rt);
        s.mount("space,enter");
        s.pointerDown(0, (s.controls().get(0).nx + 0.03f) * 1280,
                (s.controls().get(0).ny + 0.05f) * 720);
        check("releaseAll 前 space 置位", rt.keys[java.awt.event.KeyEvent.VK_SPACE]);
        s.releaseAll();
        check("releaseAll 后 space 归零", !rt.keys[java.awt.event.KeyEvent.VK_SPACE]);
        check("releaseAll 后 enter 归零", !rt.keys[java.awt.event.KeyEvent.VK_ENTER]);
        check("releaseAll 后 axis 归零", Math.abs(s.axis()[0]) < 0.01f);
    }
}
