# -*- coding: utf-8 -*-
"""
生成 Waffo 商品图（1200x630，结账页展示用）
用法：python scripts/make-product-images.py
输出：business/product-images/*.png
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "business", "product-images")
os.makedirs(OUT, exist_ok=True)

W, H = 1200, 630
BG = (13, 21, 38)          # 深海军蓝
BRAND = (29, 78, 216)       # GoShip 蓝
ACCENT = (245, 158, 11)     # 琥珀色
WHITE = (255, 255, 255)
MUTED = (148, 163, 184)

FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_MONO = r"C:\Windows\Fonts\consola.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make(title_cn, title_en, price, period, features, badge, filename):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 左侧色带
    d.rectangle([0, 0, 14, H], fill=BRAND)
    # 右上装饰圆
    d.ellipse([W - 260, -140, W + 60, 180], fill=(23, 37, 66))

    # 品牌行
    d.text((70, 58), "GoShip", font=font(FONT_BOLD, 40), fill=WHITE)
    d.text((228, 70), "出海快启", font=font(FONT_REG, 26), fill=MUTED)

    # 徽章
    bw = d.textlength(badge, font=font(FONT_BOLD, 22)) + 44
    rounded(d, [70, 138, 70 + bw, 186], 24, ACCENT)
    d.text((92, 148), badge, font=font(FONT_BOLD, 22), fill=(31, 19, 0))

    # 主标题（英文副标题控制长度，避免与右侧列表重叠）
    d.text((70, 222), title_cn, font=font(FONT_BOLD, 72), fill=WHITE)
    d.text((70, 314), title_en, font=font(FONT_REG, 26), fill=MUTED)

    # 价格
    d.text((70, 386), price, font=font(FONT_BOLD, 76), fill=ACCENT)
    pw = d.textlength(price, font=font(FONT_BOLD, 76))
    d.text((70 + pw + 16, 424), period, font=font(FONT_REG, 28), fill=MUTED)

    # 特性列表（右下）
    y = 232
    for f in features:
        d.text((640, y), "✓", font=font(FONT_BOLD, 24), fill=(22, 163, 74))
        d.text((678, y), f, font=font(FONT_REG, 24), fill=(203, 213, 225))
        y += 46

    # 底部域名
    d.text((70, 560), "getgoship.com", font=font(FONT_MONO, 24), fill=BRAND)

    path = os.path.join(OUT, filename)
    img.save(path, "PNG")
    print("OK", path, f"{os.path.getsize(path)//1024}KB")


make(
    "GoShip 专业版", "Pro · SaaS Starter Kit",
    "$29", "一次买断 · 永久使用",
    ["约 2000 行零依赖源码", "内置支付接入 + 自动开通", "管理后台 + 数据埋点", "商用授权 · 12 个月更新"],
    "最受欢迎", "product-pro.png",
)
make(
    "GoShip 团队版", "Team · Up to 5 Developers",
    "$139", "一次买断 · 终身更新",
    ["专业版全部功能", "最多 5 人团队授权", "优先支持（48 小时）", "部署协助一次"],
    "团队首选", "product-team.png",
)
make(
    "GoShip 更新订阅", "Updates · New Versions",
    "$14", "/ 年 · 随时取消",
    ["持续获取新版本", "技术支持优先响应", "不影响已买断使用权", "团队版无需订阅"],
    "老用户专享", "product-update.png",
)
