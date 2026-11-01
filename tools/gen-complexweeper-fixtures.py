"""生成复雷加殊的共享 fixtures（第三方 oracle，独立于 Java / TS 两套实现）。

输出：test/fixtures/complexweeper.json
用法：python tools/gen-complexweeper-fixtures.py

规则来源 docs/complexweeper-rules.md：
  n = sumRe^2 + sumIm^2
  isInt = (n 是完全平方数)          -> 显示十进制整数 sqrt(n)
  labelText = "n" 或 "√n"（U+221A）

  ratioOk(fR,fI,aR,aI) = A 或 B：
     A（同向）: fR*aI == fI*aR
     B（反向）: fR*aR == fI*aI
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "test", "fixtures", "complexweeper.json")
RADICAL = "\u221a"  # √


def mod_sq(re, im):
    return re * re + im * im


def is_int(re, im):
    n = mod_sq(re, im)
    r = math.isqrt(n)
    return r * r == n


def label_text(re, im):
    n = mod_sq(re, im)
    r = math.isqrt(n)
    if r * r == n:
        return str(r)
    return RADICAL + str(n)


def ratio_ok(fr, fi, ar, ai):
    return (fr * ai == fi * ar) or (fr * ar == fi * ai)


def main():
    labels = []
    for re in range(-8, 9):
        for im in range(-8, 9):
            labels.append({
                "re": re,
                "im": im,
                "n": mod_sq(re, im),
                "isInt": is_int(re, im),
                "label": label_text(re, im),
            })

    ratios = []
    for fr in range(0, 5):
        for fi in range(0, 5):
            for ar in range(0, 5):
                for ai in range(0, 5):
                    ratios.append({
                        "fR": fr, "fI": fi, "aR": ar, "aI": ai,
                        "ok": ratio_ok(fr, fi, ar, ai),
                    })

    # 邻近布雷用的「四邻域和」案例：给出 8 个雷值与期望和，供两侧核对
    sums = []
    cases = [
        ([], 0, 0),
        ("+1", 1, 0),
        ("-1", -1, 0),
        ("+i", 0, 1),
        ("-i", 0, -1),
        ("+1,-1", 0, 0),
        ("+i,-i", 0, 0),
        ("+1,+1", 2, 0),
        ("+1,+i", 1, 1),
        ("+1,-i", 1, -1),
        ("-1,+i", -1, 1),
        ("+1,+1,+i,+i", 2, 2),
        ("+1,-1,+i,-i", 0, 0),
        ("+i,+i", 0, 2),
        ("+1,+1,+1", 3, 0),
    ]
    for vals, er, ei in cases:
        if isinstance(vals, str):
            vals = [v for v in vals.split(",") if v]
        elif not isinstance(vals, list):
            vals = list(vals)
        re = im = 0
        for v in vals:
            if v == "+1":
                re += 1
            elif v == "-1":
                re -= 1
            elif v == "+i":
                im += 1
            elif v == "-i":
                im -= 1
        assert (re, im) == (er, ei), (vals, re, im, er, ei)
        sums.append({"mines": vals, "re": re, "im": im,
                     "label": label_text(re, im), "n": mod_sq(re, im)})

    doc = {
        "note": "复雷加殊规则 fixtures；由 gen-complex-fixtures.py 生成，Java 与 Node 两侧都必须过。",
        "source": ".tmp_lead_ms/COMPLEX_RULES.md",
        "labels": labels,
        "ratios": ratios,
        "sums": sums,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("wrote", OUT, "labels", len(labels), "ratios", len(ratios), "sums", len(sums))


if __name__ == "__main__":
    main()
