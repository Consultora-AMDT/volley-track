"""Iconos PWA con paleta Santa Ana y San Rafael."""
from PIL import Image, ImageDraw
import math


# Paleta del colegio
GREEN_DARK = (0, 126, 89)      # verde principal
GREEN_LIGHT = (78, 176, 93)    # verde claro
BLUE = (14, 131, 198)          # azul


def make_volleyball(ball_size: int) -> Image.Image:
    layer = Image.new("RGBA", (ball_size, ball_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    cx = cy = ball_size // 2
    r = ball_size // 2 - 2
    line_w = max(3, ball_size // 22)

    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255))

    for angle_deg in (90, 210, 330):
        a = math.radians(angle_deg)
        ax = cx + math.cos(a) * r * 1.05
        ay = cy + math.sin(a) * r * 1.05
        arc_r = r * 1.35
        bbox = [ax - arc_r, ay - arc_r, ax + arc_r, ay + arc_r]
        back_angle = math.degrees(math.atan2(cy - ay, cx - ax))
        draw.arc(bbox, start=back_angle - 32, end=back_angle + 32,
                 fill=(15, 23, 42, 255), width=line_w)

    mask = Image.new("L", (ball_size, ball_size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, ball_size, ball_size], fill=255)
    layer.putalpha(mask)

    border = Image.new("RGBA", (ball_size, ball_size), (0, 0, 0, 0))
    ImageDraw.Draw(border).ellipse(
        [0, 0, ball_size - 1, ball_size - 1],
        outline=(15, 23, 42, 255), width=max(2, line_w // 2),
    )
    return Image.alpha_composite(layer, border)


def make_icon(size: int, maskable: bool = False) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Gradiente horizontal: verde oscuro → azul (refleja la composición del logo)
    for x in range(size):
        t = x / size
        r = int(GREEN_DARK[0] + (BLUE[0] - GREEN_DARK[0]) * t)
        g = int(GREEN_DARK[1] + (BLUE[1] - GREEN_DARK[1]) * t)
        b = int(GREEN_DARK[2] + (BLUE[2] - GREEN_DARK[2]) * t)
        draw.rectangle([x, 0, x + 1, size], fill=(r, g, b, 255))

    if not maskable:
        mask = Image.new("L", (size, size), 0)
        radius = int(size * 0.22)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=radius, fill=255)
        img.putalpha(mask)

    ball_size = int(size * (0.55 if maskable else 0.66))
    ball = make_volleyball(ball_size)
    img.paste(ball, ((size - ball_size) // 2, (size - ball_size) // 2), ball)
    return img


make_icon(192).save("public/icon-192.png")
make_icon(512).save("public/icon-512.png")
make_icon(512, maskable=True).save("public/icon-maskable-512.png")
make_icon(180).save("public/apple-touch-icon.png")

favicon = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
<stop offset="0%" stop-color="#007E59"/><stop offset="100%" stop-color="#0E83C6"/>
</linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#g)"/>
<circle cx="32" cy="32" r="20" fill="white" stroke="#0F172A" stroke-width="2"/>
<path d="M 18 28 Q 32 18 46 28" stroke="#0F172A" stroke-width="2.5" fill="none"/>
<path d="M 22 44 Q 32 30 22 22" stroke="#0F172A" stroke-width="2.5" fill="none"/>
<path d="M 42 44 Q 32 30 42 22" stroke="#0F172A" stroke-width="2.5" fill="none"/>
</svg>"""
with open("public/favicon.svg", "w") as f:
    f.write(favicon)
print("OK")
