# VolleyTrack 🏐

PWA instalable para que los padres sigan **en vivo y de forma colaborativa** los partidos de voleibol de sus hijos. Un padre crea el partido, comparte un enlace por WhatsApp, y a partir de ahí **cualquier padre del grupo puede sumar puntos, rotar y editar la plantilla** desde su móvil. Todo se sincroniza en tiempo real.

## Cómo funciona

1. Un padre crea el partido en la app → la app le da un enlace único
2. Lo pega en el WhatsApp del grupo
3. El resto de padres abren el enlace y ven el partido en vivo
4. **Todos pueden contribuir**: sumar puntos, deshacer, rotar, editar la plantilla, finalizar el partido
5. **Anti-doble-click**: si dos padres pulsan PUNTO para el mismo equipo en menos de **10 segundos**, se considera el mismo punto. El que llega tarde ve un aviso "Punto ya sumado hace Xs por otro padre"

La lógica de puntuación (sets, side-out, rotación, victoria) corre **server-side** en una función Postgres (`add_point`) con `SELECT FOR UPDATE` para garantizar atomicidad — sin race conditions aunque tres padres pulsen a la vez.

## ⚠️ Configuración antes de desplegar

### 1. Crear proyecto Supabase

1. Entra en [supabase.com](https://supabase.com) → New project (free tier).
2. Elige una región cercana (eu-west-1 para España).
3. Espera 2 minutos a que se aprovisione.

### 2. Ejecutar el esquema SQL

Dashboard Supabase → **SQL Editor** → New query → pega el contenido de `supabase-schema.sql` → **Run**.

Crea la tabla `matches`, las políticas RLS y activa Realtime.

### 3. Activar auth anónima

Dashboard → **Authentication** → **Providers** → **Anonymous Sign-Ins** → **Enable**.

Sin esto los padres no podrán entrar a ver partidos.

### 4. Copiar las claves

Dashboard → **Project Settings** → **API**. Copia:
- `Project URL` → `VITE_SUPABASE_URL`
- `anon public key` → `VITE_SUPABASE_ANON_KEY`

Crea `.env` en la raíz (o configúralo en Vercel) con:

```bash
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...
```

> La `anon key` es **pública por diseño**: está pensada para ir en el frontend. La seguridad real la dan las políticas RLS del esquema.

### 5. Configurar feedback

Edita `src/config.js`:

```js
export const FEEDBACK = {
  whatsapp: '34600123456',  // tu WhatsApp sin '+' ni espacios
  email: 'tu@email.com',
};
```

## Desarrollo local

```bash
npm install
cp .env.example .env  # rellena las dos variables
npm run dev
```

Abre `http://localhost:5173`.

## Deploy en Vercel

1. Sube el repo a GitHub.
2. [vercel.com/new](https://vercel.com/new) → importa el repo.
3. En **Environment Variables**, añade:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy. URL tipo `https://volley-track.vercel.app`.
5. Reparte la URL a los padres por WhatsApp.

## Distribución a los padres

Mensaje sugerido para el grupo:

> 🏐 He instalado una app para seguir los partidos en vivo.
> Ábrela aquí: https://volley-track.vercel.app
> En iPhone: Compartir → Añadir a pantalla de inicio.
> En Android: aparece el banner "Instalar app".

Cuando haya partido, el anotador comparte el enlace específico del partido — el resto lo abre y lo sigue en vivo.

## Seguridad

- **Dependencias**: 0 vulnerabilidades (`npm audit`)
- **Cabeceras HTTP**: CSP estricta, HSTS, X-Frame-Options DENY, Referrer-Policy estricta, Permissions-Policy bloqueando cámara/micro/geo/FLoC. Configuradas en `vercel.json` y `public/_headers`.
- **Row Level Security** en la tabla `matches`:
  - SELECT público (necesario para que cualquier padre con el link lea por hash)
  - INSERT solo por usuarios autenticados creando su propia fila
  - UPDATE por cualquier usuario autenticado (modelo colaborativo)
  - DELETE solo por el creador del partido
- **Funciones RPC atómicas** (`add_point`, `undo_point`) con `SELECT FOR UPDATE` para evitar race conditions cuando varios padres tocan a la vez
- **Dedupe server-side** de 10 segundos: la lógica vive en Postgres, no en el cliente → no se puede saltar manipulando el navegador
- **UUIDs como IDs**: 122 bits de entropía, prácticamente imposible adivinar IDs ajenos
- **XSS**: React escapa por defecto; cero `dangerouslySetInnerHTML`
- **Inputs validados**: maxLength en todos los campos + CHECK constraints en Postgres
- **Sin tracking, sin analítica de terceros**

### Vector aceptado

Con la `anon key`, técnicamente alguien podría hacer `SELECT * FROM matches` y listar todos los partidos del sistema (RLS permite SELECT a todos). Para uso amateur con padres, asumimos este riesgo a cambio de simplicidad. Si en el futuro se quiere endurecer, se sustituye la política SELECT por una función RPC con parámetro `match_id`.

## Stack

- **Vite 6 + React 18**
- **Tailwind CSS**
- **vite-plugin-pwa** — manifest, service worker, instalable
- **@supabase/supabase-js** — auth anónima, realtime, Postgres
- **lucide-react** — iconos

## Estructura

```
volley-app/
├── public/
│   ├── _headers              ← cabeceras Netlify
│   ├── icon-*.png            ← iconos PWA
│   └── favicon.svg
├── src/
│   ├── App.jsx               ← router + vistas (home/setup/match/history)
│   ├── api.js                ← cliente Supabase + RPCs + realtime
│   ├── storage.js            ← tracking local de partidos visitados
│   ├── config.js             ← ⚠️ contactos feedback + límites
│   ├── FeedbackButton.jsx
│   ├── ShareButton.jsx
│   ├── main.jsx
│   └── index.css
├── supabase-schema.sql       ← schema + RLS + RPCs add_point/undo_point
├── .env.example
├── vercel.json               ← cabeceras + CSP
├── vite.config.js            ← config PWA
└── package.json
```

## Roadmap (siguientes funciones)

Pensadas para mantener la arquitectura:

- **Stats por jugadora** — kills, errores, aces, bloqueos. Tabla nueva `match_stats` con FK a `matches.id`. Solo el anotador edita.
- **Marca a tu hija/o como protagonista** — preferencia local + resumen destacado al final
- **Sustituciones y tiempos muertos**
- **Resumen compartible como imagen** — `html-to-image` para generar PNG y compartir por WhatsApp
- **Multi-equipo / multi-temporada** — añadir tabla `teams`, agrupar matches por team
- **Líbero** — marcado especial, no cuenta como cambio
- **Notificaciones push** — Supabase + web-push para avisar cuando empieza un partido del grupo
- **Modo offline-first del anotador** — cola local con sincronización al recuperar conexión (IndexedDB)

## Comandos

```bash
npm run dev      # desarrollo
npm run build    # build producción → dist/
npm run preview  # servir el build localmente
```

## Licencia

MIT.
