package Studio.runtime;

/**
 * 视口：把 .bwproj 的「世界坐标」换算成窗口里的「屏幕坐标」。
 *
 * <p>这里是编辑器到引擎的唯一几何契约，必须和 Web 编辑器的绘制真值保持一字不差，
 * 真值在 {@code web/src/app/painter.ts}：
 *
 * <ul>
 *   <li>世界坐标 X 向右、Y 向下，1 单位 = 1 像素（不是米、不是格）</li>
 *   <li>对象的 {@code (x, y)} 是<b>中心点</b>，不是左上角</li>
 *   <li>场景矩形 = {@code [0, widthTiles*tileSize] × [0, heightTiles*tileSize]}</li>
 *   <li>{@code rotation} 单位是度，屏幕上表现为顺时针</li>
 * </ul>
 *
 * <p>屏幕映射只有一个公式：
 * <pre>screen = (world - cam) * zoom + view / 2</pre>
 * 其中 {@code cam} 是「视口中心对准的世界坐标」。之前运行时直接
 * {@code translate(-cam)} 且没有补 {@code view/2}，等于把相机中心当成屏幕左上角：
 * 地图一大就变成「整体偏移、只看到一角」，这正是本次修的根因。
 *
 * <p>默认视图等价编辑器的「缩放到整张地图」（F 键）：整张地图等比 contain 铺满窗口并居中。
 * 玩家挂了 {@code fx.cameraFollow / show.camera} 时切成 1:1 跟随玩家。
 */
public final class Viewport {

    /** 与编辑器手动缩放下限一致。 */
    public static final float MIN_ZOOM = 0.15f;
    /**
     * fit 的上限。编辑器视口钳 2，但打包后的游戏要铺满全屏（4:3 的地图放进 1080p
     * 要 2.2~2.7 倍才铺满高度），所以运行时放宽到 4。
     */
    public static final float MAX_ZOOM = 4f;

    /** 整图 contain：等比缩到整张地图都看得见，四边可能留边。 */
    public static final int FIT_CONTAIN = 0;
    /** cover：等比缩到铺满视口，超出部分被裁掉（不留黑边）。 */
    public static final int FIT_COVER = 1;

    /**
     * 默认留边（contain）：整张地图等比塞进视口、居中，四边可能留雷同底色（不会裁掉任何内容）。
     * 按 F 可切到 cover（铺满、裁掉超出部分）。
     */
    public int fitMode = FIT_CONTAIN;

    public int viewW = 1280;
    public int viewH = 720;

    public float mapW = 1f;
    public float mapH = 1f;

    /** 世界单位 → 屏幕像素的倍数。 */
    public float zoom = 1f;

    /** 视口中心对应的世界坐标。 */
    public float camX = 0f;
    public float camY = 0f;

    public void setViewport(int width, int height) {
        viewW = Math.max(1, width);
        viewH = Math.max(1, height);
    }

    public void setMap(float width, float height) {
        mapW = Math.max(1f, width);
        mapH = Math.max(1f, height);
    }

    public static float clampZoom(float z) {
        if (!(z > 0f) || Float.isNaN(z) || Float.isInfinite(z)) {
            return 1f;
        }
        return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    }

    /** 整张地图等比塞进窗口的倍数（cover 时是铺满窗口、允许裁边的倍数）。 */
    public float fitZoom() {
        float z = fitMode == FIT_COVER
                ? Math.max(viewW / mapW, viewH / mapH)
                : Math.min(viewW / mapW, viewH / mapH);
        return clampZoom(z);
    }

    public String fitModeName() {
        return fitMode == FIT_COVER ? "铺满 Cover" : "留边 Contain";
    }

    /** 等价编辑器「缩放到整张地图」：整图 contain 居中。 */
    public void fitWholeMap() {
        zoom = fitZoom();
        camX = mapW / 2f;
        camY = mapH / 2f;
    }

    /** 1:1 像素视图（相机跟随用）。 */
    public void actualSize() {
        zoom = 1f;
    }

    public void centerOn(float worldX, float worldY) {
        camX = worldX;
        camY = worldY;
        clampCamera();
    }

    /** 视野不越出地图；地图比视野小时改为居中。 */
    public void clampCamera() {
        float halfW = viewW / (2f * zoom);
        float halfH = viewH / (2f * zoom);
        if (mapW <= halfW * 2f) {
            camX = mapW / 2f;
        } else {
            camX = Math.max(halfW, Math.min(mapW - halfW, camX));
        }
        if (mapH <= halfH * 2f) {
            camY = mapH / 2f;
        } else {
            camY = Math.max(halfH, Math.min(mapH - halfH, camY));
        }
    }

    /** 视口左上角对应的世界坐标。 */
    public float worldLeft() {
        return camX - viewW / (2f * zoom);
    }

    public float worldTop() {
        return camY - viewH / (2f * zoom);
    }

    /** 视口在世界里的可见宽度 / 高度。 */
    public float worldViewW() {
        return viewW / zoom;
    }

    public float worldViewH() {
        return viewH / zoom;
    }

    // ---------------- 正/反变换 ----------------

    /** 屏幕抖动偏移（相机 shake），只影响画面，不影响世界坐标与鼠标反变换。 */
    public float shakeX = 0f;
    public float shakeY = 0f;

    public float toScreenX(float worldX) {
        return (worldX - camX) * zoom + viewW / 2f + shakeX;
    }

    public float toScreenY(float worldY) {
        return (worldY - camY) * zoom + viewH / 2f + shakeY;
    }

    public float toWorldX(float screenX) {
        return (screenX - viewW / 2f) / zoom + camX;
    }

    public float toWorldY(float screenY) {
        return (screenY - viewH / 2f) / zoom + camY;
    }

    /**
     * 把视口变换压到当前的 GL 模型矩阵上。
     * 调用前矩阵必须是单位阵（glLoadIdentity）。
     */
    public void applyGL(javax.media.opengl.GL2 gl) {
        gl.glTranslatef(viewW / 2f - camX * zoom + shakeX, viewH / 2f - camY * zoom + shakeY, 0f);
        gl.glScalef(zoom, zoom, 1f);
    }

    public String describe() {
        return "view=" + viewW + "x" + viewH
                + " map=" + round(mapW) + "x" + round(mapH)
                + " zoom=" + round3(zoom)
                + " cam=(" + round(camX) + "," + round(camY) + ")";
    }

    private static String round(float v) {
        return String.valueOf(Math.round(v));
    }

    private static String round3(float v) {
        return String.valueOf(Math.round(v * 1000f) / 1000f);
    }
}
