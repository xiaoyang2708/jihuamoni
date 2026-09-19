#!/usr/bin/env python3
"""
生成思源黑体的中文子集。

为什么要做这一步
----------------
思源黑体（Noto Sans SC）完整版是 17 MB —— 直接当网页字体用，用户第一次打开
要等半天。但这个工具里显示的中文，全部出自程序自己的字符串（没有用户自由输入），
所以用到的字是固定的：把源码扫一遍，把出现过的字挑出来，单独打包一份。

裁剪之后大概 200–400 KB，gzip 之后更小，service worker 还会缓存下来离线用。

顺带还会塞进去：ASCII、全部数字、中英文标点、以及一份常用字兜底
（万一以后加了新文案、或者用户导入的数据里有生僻字，不至于变成方框）。

怎么用
------
    python tools/make-font-subset.py

改了界面文案之后重新跑一次就行。字体文件不存在时会自动跳过，
不会让构建失败 —— 网页那边已经写好了回退字体。
"""

import os
import subprocess
import sys

# Windows 的默认控制台是 GBK，打印生僻字或符号会直接抛 UnicodeEncodeError。
# 改成 UTF-8 + replace，打不出来的字变成问号也不会让脚本崩。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "fonts")
OUT_FILE = os.path.join(OUT_DIR, "noto-sans-sc-subset.woff2")
CHARS_FILE = os.path.join(OUT_DIR, ".chars.txt")

# 扫描这些文件里的字。加新文件记得补进来。
SOURCES = [
    "index.html",
    "js/app.js",
    "js/config.js",
    "js/engine.js",
    "js/stats.js",
    "js/archive.js",
    "js/demo.js",
    "manifest.webmanifest",
]

# Windows 上思源黑体的常见位置；都没有就报错让人自己去下
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\NotoSansSC-VF.ttf",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts", "NotoSansSC-VF.ttf"),
]


def collect_chars():
    chars = set()
    for rel in SOURCES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            chars.update(f.read())

    # 只留"看得见"的字符，控制字符和空白不要
    chars = {c for c in chars if c.isprintable()}

    # 数字和拉丁字母：A-Z a-z 0-9 全要。缺一个字母就可能出现方框。
    chars.update(chr(c) for c in range(0x20, 0x7F))

    # 中文标点和常见符号
    chars.update("　、。〈〉《》「」『』【】〔〕〖〗！＂＃％＆＇（）＊＋，－．／"
                 "０１２３４５６７８９：；＜＝＞？＠［＼］＾＿｀｛｜｝～"
                 "·—…‰′″℃×÷±≈≠≤≥∞√∑√←↑→↓↔⇒⇔■□●○◆◇★☆✓✔✗✘"
                 "①②③④⑤⑥⑦⑧⑨⑩")

    # 常用字兜底：把 GB2312 一级字表（3755 个最常用汉字）全带上。
    # 不用手打的字表——手打的必然有洞，而且看不出来。
    chars.update(gb2312_level1())

    return "".join(sorted(chars))


# GB2312 一级字表：3755 个最常用汉字，按编码区顺序排的。
# 直接从 Python 自带的 gb2312 编解码器生成，不用手抄。
_GB1 = None


def gb2312_level1():
    global _GB1
    if _GB1 is not None:
        return _GB1
    out = set()
    for hi in range(0xB0, 0xD8):        # 区 16–55 就是一级汉字
        for lo in range(0xA1, 0xFF):
            try:
                out.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                continue
    _GB1 = out
    return out


def find_font():
    for p in FONT_CANDIDATES:
        if p and os.path.exists(p):
            return p
    return None


def main():
    # --check：只检查，不重新生成。源码里出现了字体里没有的字就报出来。
    # 用来防"改了文案忘了重新生成字体"——那些字会掉回系统字体，看着就是两个字。
    if "--check" in sys.argv:
        if not os.path.exists(OUT_FILE):
            print("字体还没生成过，先跑一次不带参数的本脚本。")
            return 1
        from fontTools.ttLib import TTFont
        cmap = TTFont(OUT_FILE).getBestCmap()
        # 拿完整字体做参照：完整字体里本来就没有的字（比如 ☕ 这种 emoji）
        # 不算"漏了"，那是这套字体压根没有，跟子集没关系。
        src = find_font()
        full = TTFont(src).getBestCmap() if src else {}
        missing = sorted({c for c in collect_chars()
                          if ord(c) in full and ord(c) not in cmap})
        if not missing:
            print("字体是最新的，源码里每个字都在子集里。")
            return 0
        print("有 %d 个字没进子集，它们会掉回系统字体：" % len(missing))
        print("  " + "".join(missing))
        print("跑一次 python tools/make-font-subset.py 就好了。")
        return 1

    src = find_font()
    if not src:
        print("没找到思源黑体：")
        for p in FONT_CANDIDATES:
            print("  " + p)
        print("装了的话把它拷到 fonts/ 目录下再跑一次。")
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    text = collect_chars()
    with open(CHARS_FILE, "w", encoding="utf-8") as f:
        f.write(text)

    print("字体来源：%s" % src)
    print("要保留的字符数：%d" % len(text))

    cmd = [
        sys.executable, "-m", "fontTools.subset", src,
        "--text-file=" + CHARS_FILE,
        "--flavor=woff2",
        "--output-file=" + OUT_FILE,
        # 保留连字/字距这些排版特性，不然中文标点的间距会变
        "--layout-features=*",
        "--notdef-outline",
        # 变量字体的字重轴整条保留，界面上 300–800 各档都要用
        "--name-IDs=*",
        "--drop-tables+=DSIG",
    ]
    print("跑：pyftsubset …")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr)
        return r.returncode

    size = os.path.getsize(OUT_FILE)
    print("完成：%s" % OUT_FILE)
    print("大小：%.0f KB（原来的 %.1f MB）" % (size / 1024, os.path.getsize(src) / 1024 / 1024))
    os.remove(CHARS_FILE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
