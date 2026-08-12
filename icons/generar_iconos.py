"""
Genera los iconos PNG de la PWA.
Uso:  python generar_iconos.py
(Solo hay que volver a correrlo si cambias el diseno del icono.)
"""
from PIL import Image, ImageDraw
import math, os

AQUI = os.path.dirname(os.path.abspath(__file__))

FONDO_A = (10, 8, 26)      # arriba izq
FONDO_B = (42, 10, 61)     # abajo der
CIAN    = (0, 229, 255)
MAGENTA = (255, 45, 149)


def degradado(size):
    """Fondo con degradado diagonal."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            px[x, y] = (
                int(FONDO_A[0] + (FONDO_B[0] - FONDO_A[0]) * t),
                int(FONDO_A[1] + (FONDO_B[1] - FONDO_A[1]) * t),
                int(FONDO_A[2] + (FONDO_B[2] - FONDO_A[2]) * t),
            )
    return img


def resplandor(img, cx, cy, radio, color, fuerza=0.55):
    """Halo radial suave alrededor de (cx, cy)."""
    size = img.size[0]
    capa = Image.new("RGB", (size, size), (0, 0, 0))
    px = capa.load()
    x0, y0 = max(0, int(cx - radio)), max(0, int(cy - radio))
    x1, y1 = min(size, int(cx + radio)), min(size, int(cy + radio))
    for y in range(y0, y1):
        for x in range(x0, x1):
            d = math.hypot(x - cx, y - cy) / radio
            if d < 1:
                k = (1 - d) ** 2 * fuerza
                px[x, y] = (int(color[0] * k), int(color[1] * k), int(color[2] * k))
    return Image.blend(img, Image.new("RGB", (size, size), (0, 0, 0)), 0).point(lambda v: v) \
        if False else _sumar(img, capa)


def _sumar(a, b):
    from PIL import ImageChops
    return ImageChops.add(a, b)


def dibujar_mic(d, size, escala=1.0):
    """Microfono centrado, estilo linea gruesa."""
    c = size / 2
    u = size * 0.013 * escala          # grosor de linea
    cuerpo_w = size * 0.155 * escala
    cuerpo_h = size * 0.30 * escala
    top = c - size * 0.215 * escala

    # capsula
    d.rounded_rectangle(
        [c - cuerpo_w / 2, top, c + cuerpo_w / 2, top + cuerpo_h],
        radius=cuerpo_w / 2, fill=CIAN,
    )
    # arco inferior
    r = size * 0.175 * escala
    d.arc([c - r, c - r * 0.62, c + r, c + r * 1.05],
          start=15, end=165, fill=CIAN, width=int(u * 1.9))
    # pie
    pie_y = c + r * 0.95
    d.line([c, pie_y, c, pie_y + size * 0.075 * escala], fill=CIAN, width=int(u * 1.9))
    base_w = size * 0.10 * escala
    d.line([c - base_w, pie_y + size * 0.075 * escala,
            c + base_w, pie_y + size * 0.075 * escala], fill=CIAN, width=int(u * 1.9))


def dibujar_ondas(d, size, escala=1.0):
    """Ondas laterales que sugieren sonido."""
    c = size / 2
    for i, (rr, col) in enumerate([(0.30, CIAN), (0.385, MAGENTA)]):
        r = size * rr * escala
        w = max(2, int(size * 0.011 * escala))
        d.arc([c - r, c - r, c + r, c + r], start=205, end=245, fill=col, width=w)
        d.arc([c - r, c - r, c + r, c + r], start=295, end=335, fill=col, width=w)


def construir(size, maskable=False):
    img = degradado(size)
    c = size / 2
    img = resplandor(img, c, c * 0.92, size * 0.42, CIAN, 0.42)
    img = resplandor(img, c * 1.25, c * 1.3, size * 0.34, MAGENTA, 0.26)

    d = ImageDraw.Draw(img)
    # en maskable el contenido va mas chico (zona segura del recorte circular)
    esc = 0.72 if maskable else 1.0
    dibujar_ondas(d, size, esc)
    dibujar_mic(d, size, esc)

    if not maskable:
        # esquinas redondeadas
        mascara = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mascara).rounded_rectangle(
            [0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
        salida = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        salida.paste(img, (0, 0), mascara)
        return salida
    return img.convert("RGBA")


for nombre, size, mask in [
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable-512.png", 512, True),
]:
    construir(size, mask).save(os.path.join(AQUI, nombre))
    print("generado:", nombre)
