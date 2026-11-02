package Studio.runtime;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;

import javax.media.opengl.GL2;

/**
 * 格子绘制器：把 {@link GridBoard} 画成一张纹理再贴出去。
 *
 * <p><b>为什么抽出来</b>：扫雷原本在 {@code paint()} 里干了三件事 ——
 * 画格子底/边框、按状态上色、在格子里写字。这套「画格子」的活任何网格玩法都要做
 * （数织、围线、战棋、消除、推箱子）。抽成独立模块后：
 * <ul>
 *   <li>新玩法只需提供「每格该画什么颜色/文字」，其余交给本类；</li>
 *   <li>离屏绘制 + 纹理缓存 + 脏标记这套开销优化只维护一份；</li>
 *   <li>{@code Minesweeper} 从 626 行降到「状态机 + 规约」，可读性恢复。</li>
 * </ul>
 *
 * <p><b>用法</b>：构造时给棋盘与格子数，调用 {@link #paintIfDirty} 按 {@link Painter} 回调
 * 重画位图，{@link #draw(GL2, float, float)} 贴到世界坐标。
 *
 * <p><b>为什么用位图而不是直接画 GL 矩形</b>：格子里要写字（数字/标记），
 * 文字走 GL 纹理更省事；而且「一整块棋盘 = 一张纹理」只需一次 draw call，
 * 40x40 的棋盘也不会掉帧。
 */
final class GridPainter {

    /** 单格绘制回调：往 Graphics2D 上画这一格。 */
    interface Painter {
        /**
         * @param g     画布（已设好抗锯齿）
         * @param board 棋盘状态
         * @param idx   格子索引
         * @param x,y   该格左上角像素坐标
         * @param cell  格子边长
         * @return true = 这一格有内容被画（用于判断是否需要贴图）
         */
        boolean paintCell(Graphics2D g, GridBoard board, int idx, int x, int y, int cell);
    }

    private final TopDownRuntime rt;
    private GridBoard board;

    /**
     * 换绑到新的棋盘（行/列/格子尺寸变化后必须调用）。
     *
     * <p><b>为什么必须有这个方法（「改列数后画面被灰色大块盖住」的真因）</b>：
     * {@code Minesweeper.reset()} 在规格变化时<b>总是</b> {@code new GridBoard(rows, cols, cell)}，
     * 但旧实现只在 {@code oldCell != cell} 时才重建 painter —— 于是「只改列数、格子尺寸不变」
     * 这条路径上 painter 仍然攥着<b>旧 board 对象</b>。它按旧 board 的
     * {@code pixelWidth()/pixelHeight()} 建离屏位图并绘制，而 {@code Minesweeper.draw()}
     * 用新 board 的尺寸算贴图位置与大小 → 两者对不上，画出来就是一块错位的纯色大矩形
     * （玩家看到「整屏被灰块盖住、HUD 和棋盘全没了」）。
     *
     * <p>换绑后必须标脏：位图尺寸与内容都变了，下一次 {@code paintIfDirty} 会按新尺寸重建。
     */
    void rebind(GridBoard newBoard) {
        if (newBoard == null || newBoard == board) {
            return;
        }
        this.board = newBoard;
        // 尺寸变了：旧位图作废（下一帧按新 pixelWidth/Height 重新分配）
        this.image = null;
        this.dirty = true;
    }

    /** 离屏位图（尺寸跟着棋盘走）。 */
    private BufferedImage image;
    /** GL 纹理句柄。 */
    private Texture texture;
    /** 需要重画。 */
    private boolean dirty = true;

    /** 底色（棋盘外的空隙与格线）。 */
    private Color background = new Color(0x1b, 0x1f, 0x27);
    /** 格线颜色。 */
    private Color gridLine = new Color(0xb6, 0xc0, 0xd4, 0x88);
    /** 是否画格线。 */
    private boolean drawGridLines = true;
    /** 整块重绘次数（诊断：判断是否每帧都在重画）。 */
    private int repaintCount;
    /** 最近一次整块重绘耗时（纳秒）。 */
    private long lastRepaintNanos;

    /** 诊断快照：重绘次数与最近耗时。 */
    String perfStats() {
        return "repaints=" + repaintCount + " lastMs="
                + String.format("%.2f", lastRepaintNanos / 1_000_000.0);
    }

    GridPainter(TopDownRuntime rt, GridBoard board) {
        this.rt = rt;
        this.board = board;
    }

    void setBackground(Color c) {
        if (c == null) {
            return;
        }
        this.background = c;
        this.dirty = true;
    }

    void setGridLine(Color c) {
        this.gridLine = c;
        this.dirty = true;
    }

    void setDrawGridLines(boolean v) {
        this.drawGridLines = v;
        this.dirty = true;
    }

    /** 标脏：下一帧重画。 */
    void invalidate() {
        dirty = true;
    }

    /**
     * GL 上下文重建后调用：<b>丢弃纹理句柄</b>（不删除，旧上下文已经没了）。
     *
     * <p><b>为什么必须单独做这一步</b>：{@link #paintIfDirty} 的分支是
     * <pre>
     *   if (texture == null)    texture = rt.textureFromImage(image);   // 新申请 id
     *   else                    rt.uploadImageTo(texture.id, image);     // 往旧 id 传像素
     * </pre>
     * 上下文重建后旧 id 已失效 —— 更糟的是它可能被驱动<b>复用给别的纹理</b>，
     * 这时会把棋盘像素写进别人的纹理里。若不把 {@code texture} 置 null，
     * {@code paintIfDirty} 永远走「往失效 id 上传」那一支，棋盘就画不出来（黑块）。
     *
     * <p>所以这里把句柄丢掉、标记重画，下一帧走 {@code texture == null} 分支重新申请。
     *
     * @return 被丢弃的旧纹理对象（调用方若要把它从「待重建」名单里摘掉，需要这个引用）
     */
    Texture invalidateTexture() {
        Texture old = texture;
        texture = null;
        dirty = true;
        return old;
    }

    boolean isDirty() {
        return dirty;
    }

    /**
     * 按需重画并上传纹理。
     *
     * @return 纹理可用则返回它，否则 null（调用方跳过绘制）
     */
    Texture paintIfDirty(GL2 gl, Painter painter) {
        int w = Math.max(1, board.pixelWidth());
        int h = Math.max(1, board.pixelHeight());

        if (image == null || image.getWidth() != w || image.getHeight() != h) {
            image = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
            dirty = true;
        }

        if (dirty) {
            long t0 = System.nanoTime();
            Graphics2D g = image.createGraphics();
            repaintCount++;
            try {
                g.setRenderingHint(RenderingHints.KEY_ANTIALIASING,
                        RenderingHints.VALUE_ANTIALIAS_ON);
                g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING,
                        RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
                // 清成全透明，避免上一轮的残留叠上来
                g.setColor(new Color(0, 0, 0, 0));
                g.fillRect(0, 0, w, h);

                if (background != null && background.getAlpha() > 0) {
                    g.setColor(background);
                    g.fillRect(0, 0, w, h);
                }

                for (int idx = 0; idx < board.size(); idx++) {
                    int r = board.rowOf(idx);
                    int c = board.colOf(idx);
                    painter.paintCell(g, board, idx, c * board.cellSize, r * board.cellSize,
                            board.cellSize);
                }

                if (drawGridLines && gridLine != null && gridLine.getAlpha() > 0) {
                    g.setColor(gridLine);
                    g.setStroke(new BasicStroke(1f));
                    for (int c = 0; c <= board.cols; c++) {
                        int x = c * board.cellSize;
                        g.drawLine(x, 0, x, h);
                    }
                    for (int r = 0; r <= board.rows; r++) {
                        int y = r * board.cellSize;
                        g.drawLine(0, y, w, y);
                    }
                }
            } finally {
                g.dispose();
            }

            // ⚠ 关键：位图重画之后必须**把新像素重新传上 GPU**。
            //
            // 早先写成 `if (texture == null) texture = rt.textureFromImage(image);`
            // —— 只有第一次建纹理时才上传。之后格子状态变了、位图重画了，
            // 但 GPU 上还是旧图像，所以「点格子画面不更新」（进度是对的、画面是死的）。
            if (texture == null) {
                texture = rt.textureFromImage(image);
            } else if (gl != null) {
                rt.uploadImageTo(texture.id, image);
            }
            dirty = false;
            lastRepaintNanos = System.nanoTime() - t0;
            if (gl != null) {
                rt.uploadTextures(gl);
            }
        }
        return (texture != null && texture.id >= 0) ? texture : null;
    }

    /** 贴到世界坐标（左上角 x,y，尺寸 = 棋盘像素尺寸，单位 = 世界单位）。 */
    void draw(GL2 gl, float x, float y, Texture tex) {
        if (tex == null || tex.id < 0) {
            return;
        }
        float w = board.pixelWidth();
        float h = board.pixelHeight();
        gl.glEnable(GL2.GL_TEXTURE_2D);
        gl.glBindTexture(GL2.GL_TEXTURE_2D, tex.id);
        gl.glColor4f(1f, 1f, 1f, 1f);
        gl.glBegin(GL2.GL_QUADS);
        gl.glTexCoord2f(0f, 0f);
        gl.glVertex2f(x, y);
        gl.glTexCoord2f(1f, 0f);
        gl.glVertex2f(x + w, y);
        gl.glTexCoord2f(1f, 1f);
        gl.glVertex2f(x + w, y + h);
        gl.glTexCoord2f(0f, 1f);
        gl.glVertex2f(x, y + h);
        gl.glEnd();
        gl.glDisable(GL2.GL_TEXTURE_2D);
    }

    /** 释放纹理（换关卡/退出时调）。 */
    /**
     * 释放这张棋盘纹理。
     *
     * <p><b>早先是假的</b>：只把 {@code texture = null}，注释写着「走宿主的删除流程」，
     * 但根本没人接手 —— 每次改行列重建 painter 就泄漏一张 GPU 纹理
     * （实测 uploadedTextures 18 → 54 只增不减，越玩越占显存）。
     * 现在真正交给宿主登记并删除。
     */
    void dispose() {
        if (texture != null) {
            rt.deleteTexture(texture);
            texture = null;
        }
        image = null;
        dirty = true;
    }

    // ---------------- 通用绘制工具（各玩法复用） ----------------

    /** 填充一格纯色。 */
    static void fillCell(Graphics2D g, Color c, int x, int y, int cell) {
        if (c == null || c.getAlpha() == 0) {
            return;
        }
        g.setColor(c);
        g.fillRect(x, y, cell, cell);
    }

    /** 一格内居中写字（自动按格宽缩字号，绝不裁切）。 */
    static void centerText(Graphics2D g, String text, Color color, int x, int y, int cell,
                           boolean bold) {
        if (text == null || text.isEmpty() || color == null || color.getAlpha() == 0) {
            return;
        }
        g.setColor(color);
        int size = Math.max(9, cell / 2);
        // 逐级缩字号直到放得下（窄格放 "√10" 这类多字符时必要）
        while (size >= 8) {
            Font f = new Font("Microsoft YaHei", bold ? Font.BOLD : Font.PLAIN, size);
            g.setFont(f);
            FontMetrics fm = g.getFontMetrics();
            if (fm.stringWidth(text) <= cell - 2) {
                break;
            }
            size--;
        }
        FontMetrics fm = g.getFontMetrics();
        int tx = x + (cell - fm.stringWidth(text)) / 2;
        int ty = y + (cell - fm.getHeight()) / 2 + fm.getAscent();
        g.drawString(text, tx, ty);
    }

    /** 一格内画描边方块（用于标记/旗帜底衬）。 */
    static void strokeCell(Graphics2D g, Color c, int x, int y, int cell, float width) {
        g.setColor(c);
        g.setStroke(new BasicStroke(width));
        g.drawRect(x, y, cell, cell);
    }
}
