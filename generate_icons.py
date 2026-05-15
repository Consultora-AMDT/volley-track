"""Genera los iconos PWA del balón de voleibol desde SVG."""
import cairosvg
from PIL import Image
import io

SVG_NORMAL = """
<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#007E59"/>
      <stop offset="100%" stop-color="#0E83C6"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="170" fill="#FFFFFF"/>
  <g stroke="#1a1a1a" stroke-width="10" fill="none" stroke-linecap="round">
    <!-- Curva diagonal de arriba-izquierda a abajo-derecha -->
    <path d="M 130 175 Q 256 256, 410 320"/>
    <!-- Curva diagonal de arriba-derecha a abajo-izquierda -->
    <path d="M 382 175 Q 256 256, 102 320"/>
    <!-- Curva vertical central -->
    <path d="M 256 86 Q 296 256, 256 426"/>
  </g>
</svg>
"""

SVG_MASKABLE = """
<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#007E59"/>
      <stop offset="100%" stop-color="#0E83C6"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="130" fill="#FFFFFF"/>
  <g stroke="#1a1a1a" stroke-width="8" fill="none" stroke-linecap="round">
    <path d="M 160 200 Q 256 256, 374 305"/>
    <path d="M 352 200 Q 256 256, 138 305"/>
    <path d="M 256 126 Q 286 256, 256 386"/>
  </g>
</svg>
"""


def render(svg, size, output_path):
    png_bytes = cairosvg.svg2png(bytestring=svg.encode('utf-8'), output_width=size, output_height=size)
    img = Image.open(io.BytesIO(png_bytes))
    img.save(output_path, 'PNG')
    print(f"  -> {output_path} ({size}x{size})")


print("Generando iconos PWA del balon...")
render(SVG_NORMAL, 192, '/home/claude/volley-app/public/icon-192.png')
render(SVG_NORMAL, 512, '/home/claude/volley-app/public/icon-512.png')
render(SVG_MASKABLE, 512, '/home/claude/volley-app/public/icon-maskable-512.png')
render(SVG_NORMAL, 180, '/home/claude/volley-app/public/apple-touch-icon.png')
print("Listo.")
