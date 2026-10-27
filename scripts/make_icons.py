"""生成扩展图标：圆角渐变底 + 白色 M↓ 标记。"""

from PIL import Image, ImageDraw, ImageFont
import os

C1 = (79, 70, 229)
C2 = (124, 58, 237)
SS = 4  # 超采样倍数


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def make(size: int) -> Image.Image:
    S = size * SS
    grad = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(grad)
    for y in range(S):
        d.line([(0, y), (S, y)], fill=lerp(C1, C2, y / max(1, S - 1)))

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.23), fill=255)

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    draw = ImageDraw.Draw(img)
    font_path = "C:/Windows/Fonts/segoeuib.ttf"
    text = "M"
    f1 = ImageFont.truetype(font_path, int(S * 0.52))
    bbox = draw.textbbox((0, 0), text, font=f1)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        (S * 0.46 - tw / 2 - bbox[0], S * 0.52 - th / 2 - bbox[1]),
        text,
        font=f1,
        fill=(255, 255, 255, 255),
    )

    # 向下箭头
    ax = S * 0.76
    top, bottom = S * 0.30, S * 0.68
    w = max(2, int(S * 0.045))
    draw.line([(ax, top), (ax, bottom - w * 2.2)], fill=(255, 255, 255, 255), width=w)
    head = w * 2.4
    draw.polygon(
        [(ax - head, bottom - head), (ax + head, bottom - head), (ax, bottom)],
        fill=(255, 255, 255, 255),
    )

    return img.resize((size, size), Image.LANCZOS)


def main():
    out = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
    os.makedirs(out, exist_ok=True)
    for size in (16, 32, 48, 128):
        make(size).save(os.path.join(out, f"icon{size}.png"))
        print("wrote", f"icon{size}.png")


if __name__ == "__main__":
    main()
