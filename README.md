# Grita para Ganar — PWA

Versión **solo software** del juego de gritos: una tablet + un micrófono cualquiera.
Sin ESP32, sin dispensador, sin tira LED. Mide el grito con el micrófono del
dispositivo y reparte premios por nivel.

## 🔴 EN VIVO

**<https://franklinleon.github.io/juego-grito-pwa/>**

Abre esa URL en la tablet → menú del navegador → **"Agregar a pantalla de inicio"**.

> Para actualizar la app publicada: edita, `git commit` y `git push`. GitHub Pages
> reconstruye en ~1 min. **Sube también `VERSION` en `sw.js`**, si no la tablet
> seguirá sirviendo la versión cacheada.

---

## 1. Probarlo ahora (en esta PC)

```bash
python -m http.server 8080 --directory juego_grito_pwa
```

Y abre <http://localhost:8080>.

> **Importante:** el navegador solo entrega el micrófono en `https://` o en
> `localhost`. Por IP local (`http://192.168.x.x`) **no funciona** — ver punto 3.

---

## 2. Cómo se usa

1. **ACTIVAR MICRÓFONO** → el navegador pide permiso (una sola vez).
2. Pantalla de reposo → **tocar** para jugar.
3. Cuenta 3-2-1 → ventana de grito (4 s por defecto) → pantalla de premio.
4. Vuelve solo a reposo a los 9 s, o tocando la pantalla.

### Panel de ajustes (oculto)
**5 toques rápidos en la esquina superior derecha.** Desde ahí, sin tocar código:

- **Calibración**: barra en vivo + dB + botones *Fijar HABLA* / *Fijar GRITO*.
- **Rangos de premio** y duración del grito.
- **Nombres y emojis** de los 3 premios.
- **Selector de micrófono** (útil con el inalámbrico: elige la entrada correcta).
- **Sorteo del premio mayor** (stock e intentos) + estado actual.
- **Estadísticas** de la jornada.

Todo se guarda en la tablet (`localStorage`) y sobrevive al cerrar la app.

---

## 3. Ponerla en producción (HTTPS obligatorio)

El micrófono exige contexto seguro. Opciones, de más simple a menos:

| Opción | Cómo | Notas |
|---|---|---|
| **GitHub Pages** | Sube la carpeta a un repo → Settings → Pages | Gratis, HTTPS automático. **Recomendado.** |
| **Netlify / Cloudflare Pages** | Arrastrar la carpeta al panel | Gratis, HTTPS, deploy en segundos |
| Servidor propio | Cualquier hosting estático con certificado | — |

Una vez desplegada: abrir la URL en la tablet → menú del navegador →
**"Agregar a pantalla de inicio"**. Queda como app a pantalla completa y
**funciona sin internet** (el service worker cachea todo).

---

## 4. Calibración en el evento (2 minutos)

Se hace una sola vez, en el lugar y con el ruido real:

1. Abrir el panel (5 toques esquina sup. derecha).
2. **Fijar HABLA** con el ambiente normal (gente hablando alrededor).
3. **Fijar GRITO** y que alguien pegue un grito real y fuerte.
4. Verificar con la barra en vivo que un grito normal llegue a ~60-80.
5. Si reparte premios demasiado fácil → subir *mínimo para premio medio/mayor*.

> **Nota técnica:** la app apaga a propósito `autoGainControl`,
> `noiseSuppression` y `echoCancellation`. Si se dejan activos, el navegador
> comprime el audio y **hablar mide casi igual que gritar** (es el mismo
> problema del AGC que hubo con el MAX9814 en la versión con hardware).

---

## 5. Premio mayor — sorteo oculto

No se gana solo por gritar fuerte. De antemano se elige **al azar** un intento
futuro (entre *altoMin* y *altoMax*) en el que el premio mayor se **arma**.
Desde ese momento lo gana el primer grito que supere el umbral. Mientras **no**
está armado, el medidor se topa justo debajo del umbral (con variación
aleatoria) para que no se note. Así el premio grande dura toda la jornada.

Configurable y reiniciable desde el panel.

---

## 6. Rebranding

Toda la identidad visual vive en los tokens `:root` de `styles.css`
(`--acento`, `--acento-2`, `--oro`, fondos). Cambiando esos colores cambia la
app entera. Los nombres/emojis de premios se editan desde el panel, sin tocar
código. Para cambiar el ícono: editar y correr `icons/generar_iconos.py`.

---

## 7. Archivos

```
index.html       pantallas (permiso, reposo, cuenta, grito, premio, ajustes)
styles.css       estilos + tokens de marca
app.js           audio, máquina de estados, sorteo, panel
manifest.webmanifest
sw.js            cache offline (subir VERSION al cambiar archivos)
icons/           íconos + script que los genera
```
