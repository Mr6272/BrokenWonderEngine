package Studio.runtime;

import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.Clip;
import javax.sound.sampled.FloatControl;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 脚本音频（契约 §2.7，Phase 1 只保证 WAV）。
 *
 * <p>素材名走宿主的素材表（{@code data.assetByName} → Build 内相对路径），
 * 也可以直接给相对/绝对文件路径。任何失败（文件缺失、无声卡、格式不支持）
 * 都只写一条告警，绝不抛到游戏循环里。
 */
final class ScriptAudio {

    private final ScriptEngine engine;
    private final TopDownRuntime host;

    private final Map<Long, Clip> clips = new LinkedHashMap<Long, Clip>();
    private final Map<Long, String> clipNames = new LinkedHashMap<Long, String>();
    private final Set<String> warned = new HashSet<String>();
    /** 一次性（非循环）clip，按播放先后排序：播完回收、超上限掐最老的。 */
    private final java.util.LinkedHashSet<Long> oneShots = new java.util.LinkedHashSet<Long>();
    private final Map<String, Pcm> pcmCache = new java.util.HashMap<String, Pcm>();
    private static final int MAX_ONE_SHOTS = 24;
    /** 只缓存短音效（≤ 2MB ≈ 22kHz 单声道 16 位 45 秒），BGM 这种大文件照常流式读。 */
    private static final int PCM_CACHE_MAX_BYTES = 2 * 1024 * 1024;
    private long nextId = 1;
    private float volume = 1f;
    private long musicId = -1;

    ScriptAudio(ScriptEngine engine) {
        this.engine = engine;
        this.host = engine.host;
    }

    // ---------------- 播放 ----------------

    /**
     * 播放音效。
     *
     * @param pitch 音高倍数（1 = 原调，2 = 高一个八度，0.5 = 低一个八度）。
     *              Java Sound 的 {@link Clip} <b>没有</b>变调控制，所以这里用
     *              <b>改变采样率</b>实现：采样率乘 pitch ⇒ 播放速率与音高同比变化
     *              （与「变速不变调」相反，这正是游戏里要的效果：受击/拾取随机音高）。
     *              pitch 缺失或 == 1 时走原始 Clip 快路径，零额外开销。
     */
    long play(String name, float vol, boolean loop, float pitch) {
        if (name == null || name.isEmpty()) {
            return -1;
        }
        File f = resolve(name);
        if (f == null) {
            warnOnce(name, "找不到音频素材「" + name + "」（Phase 1 只支持 WAV）");
            return -1;
        }
        try {
            reapFinished();
            if (!loop) {
                capOneShots();
            }
            AudioInputStream in = openPcm(f);
            if (Math.abs(pitch - 1f) > 0.001f) {
                in = detune(in, pitch);
            }
            Clip clip = AudioSystem.getClip();
            clip.open(in);
            long id = nextId++;
            clips.put(Long.valueOf(id), clip);
            clipNames.put(Long.valueOf(id), name);
            applyVolume(clip, vol * volume);
            if (loop) {
                clip.loop(Clip.LOOP_CONTINUOUSLY);
            } else {
                oneShots.add(Long.valueOf(id));
                clip.start();
            }
            return id;
        } catch (Throwable t) {
            warnOnce(name, "音频不可用「" + name + "」：" + t.getMessage());
            return -1;
        }
    }

    long play(String name, float vol, boolean loop) {
        return play(name, vol, loop, 1f);
    }

    /**
     * 回收播完的一次性 clip。
     *
     * <p>原来播完的 clip 从不 close：每发子弹一个 Clip，射击游戏几秒就把混音器的
     * 线路占满，之后所有 play() 都在 getClip/open 处失败 —— 枪声全哑。循环音（BGM）不回收。
     */
    private void reapFinished() {
        if (oneShots.isEmpty()) {
            return;
        }
        for (Long id : new ArrayList<Long>(oneShots)) {
            Clip c = clips.get(id);
            if (c == null) {
                oneShots.remove(id);
                continue;
            }
            boolean done;
            try {
                done = !c.isRunning() && c.getFramePosition() >= c.getFrameLength();
            } catch (Throwable t) {
                done = true;
            }
            if (done) {
                stop(id.longValue());
            }
        }
    }

    /** 同时发声的一次性音效上限：超出时掐掉最老的一个（连射时听感上就是「新枪声顶掉旧尾音」）。 */
    private void capOneShots() {
        while (oneShots.size() >= MAX_ONE_SHOTS) {
            Long oldest = oneShots.iterator().next();
            stop(oldest.longValue());
        }
    }

    /**
     * 解码后的 PCM 按文件缓存：连射时同一枪声每秒播十几次，每次重新读盘 + 解析 WAV 头没必要。
     * 缓存的是字节和格式，每次 play 包一个新的流（Clip 各自独立）。
     */
    private AudioInputStream openPcm(File f) throws Exception {
        String key = f.getAbsolutePath();
        Pcm p = pcmCache.get(key);
        if (p == null) {
            AudioInputStream in = AudioSystem.getAudioInputStream(f);
            try {
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    bos.write(buf, 0, n);
                }
                p = new Pcm(in.getFormat(), bos.toByteArray());
            } finally {
                try {
                    in.close();
                } catch (Throwable ignored) {
                }
            }
            if (p.data.length <= PCM_CACHE_MAX_BYTES) {
                pcmCache.put(key, p);
            }
        }
        int frameSize = Math.max(1, p.format.getFrameSize());
        return new AudioInputStream(new java.io.ByteArrayInputStream(p.data), p.format,
                Math.max(1, p.data.length / frameSize));
    }

    private static final class Pcm {
        final javax.sound.sampled.AudioFormat format;
        final byte[] data;

        Pcm(javax.sound.sampled.AudioFormat format, byte[] data) {
            this.format = format;
            this.data = data;
        }
    }

    /**
     * 变调（真正改变音高，不是「变速不变调」）。
     *
     * <p><b>踩过的坑（实测记录）</b>：最初的写法是「造一个新采样率格式，让
     * {@code AudioSystem.getAudioInputStream(dst, in)} 去重采样」。
     * 结果输出速率确实变成了 22050→33075，但<b>时长仍是 1.0001 秒，音高没变</b> ——
     * 因为 AudioSystem 做的是「重采样保时长」（resample preserving duration），
     * 它按时间轴插值，频率成分原样保留。所以那种写法等于白做。
     *
     * <p>正确做法：把原始 PCM 数据<b>原样保留</b>，只把「采样率」这个标称值乘上 pitch。
     * 播放器按新采样率解释同一串样本 ⇒ 每秒消耗的样本数变了 ⇒
     * 时长变 1/pitch、音高变 pitch 倍。这正是音效变调要的效果。
     *
     * <p>只支持 PCM（8/16/24/32 位）；非 PCM 原样返回，不崩。
     */
    private static AudioInputStream detune(AudioInputStream in, float pitch) {
        try {
            javax.sound.sampled.AudioFormat src = in.getFormat();
            if (src.getEncoding() != javax.sound.sampled.AudioFormat.Encoding.PCM_SIGNED
                    && src.getEncoding() != javax.sound.sampled.AudioFormat.Encoding.PCM_UNSIGNED) {
                return in;
            }
            // 先把流读进内存：AudioInputStream 需要已知长度，Clip.open 才接受。
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            byte[] data = bos.toByteArray();
            float newRate = Math.max(1000f, Math.min(192000f, src.getSampleRate() * pitch));
            int frameSize = Math.max(1, src.getFrameSize());
            // 采样率变了，其余（编码/位深/声道/帧大小）不变。
            javax.sound.sampled.AudioFormat dst = new javax.sound.sampled.AudioFormat(
                    src.getEncoding(), newRate, src.getSampleSizeInBits(),
                    src.getChannels(), frameSize,
                    newRate, src.isBigEndian());
            return new AudioInputStream(new java.io.ByteArrayInputStream(data),
                    dst, Math.max(1, data.length / frameSize));
        } catch (Throwable t) {
            return in;
        }
    }

    long music(String name, float vol, boolean loop) {
        if (musicId >= 0) {
            stop(musicId);
        }
        musicId = play(name, vol, loop);
        // 不循环的 BGM 也不能被「一次性音效上限」掐掉。
        oneShots.remove(Long.valueOf(musicId));
        return musicId;
    }

    void stop(long id) {
        Clip clip = clips.remove(Long.valueOf(id));
        clipNames.remove(Long.valueOf(id));
        oneShots.remove(Long.valueOf(id));
        if (id == musicId) {
            musicId = -1;
        }
        if (clip == null) {
            return;
        }
        try {
            clip.stop();
            clip.close();
        } catch (Throwable ignored) {
        }
    }

    void stopByName(String name) {
        if (name == null) {
            return;
        }
        for (Map.Entry<Long, String> e : new ArrayList<Map.Entry<Long, String>>(clipNames.entrySet())) {
            if (name.equals(e.getValue())) {
                stop(e.getKey().longValue());
            }
        }
    }

    void setVolume(float v) {
        volume = Math.max(0f, Math.min(1f, v));
        for (Clip clip : new ArrayList<Clip>(clips.values())) {
            applyVolume(clip, volume);
        }
    }

    private void applyVolume(Clip clip, float v) {
        try {
            if (clip.isControlSupported(FloatControl.Type.MASTER_GAIN)) {
                FloatControl gain = (FloatControl) clip.getControl(FloatControl.Type.MASTER_GAIN);
                double db = 20.0 * Math.log10(Math.max(0.0001, Math.min(1.0, v)));
                float min = gain.getMinimum();
                float max = gain.getMaximum();
                gain.setValue((float) Math.max(min, Math.min(max, db)));
            }
        } catch (Throwable ignored) {
        }
    }

    // ---------------- 素材解析 ----------------

    private File resolve(String name) {
        try {
            GameData.RtAsset a = host.data.assetByName(name);
            if (a != null && a.path != null && !a.path.isEmpty()) {
                File f = new File(host.assetRoot, a.path);
                if (f.isFile()) {
                    return f;
                }
            }
            File direct = new File(host.assetRoot, name);
            if (direct.isFile()) {
                return direct;
            }
            File abs = new File(name);
            if (abs.isAbsolute() && abs.isFile()) {
                return abs;
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    private void warnOnce(String key, String msg) {
        if (warned.add(key)) {
            engine.log(msg);
        }
    }

    /** 释放所有 clip（窗口关闭/引擎销毁时可选调用）。 */
    void dispose() {
        List<Long> ids = new ArrayList<Long>(clips.keySet());
        for (Long id : ids) {
            stop(id.longValue());
        }
    }
}
