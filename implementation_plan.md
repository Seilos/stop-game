# Juego de Stop — Plan de Implementación ✅ APROBADO

## Descripción

Juego multijugador online de "Stop" (Scattergories), accesible desde PC y celular vía navegador. Los jugadores acceden como guests con un apodo, crean o se unen a salas, y compiten por rondas escribiendo palabras que comiencen con una letra aleatoria según categorías predefinidas.

## Decisiones Confirmadas

| Decisión | Respuesta |
|---|---|
| ¿Incluir Ñ? | ❌ No |
| Jugador desconectado | Eliminado de la partida |
| Tiempo de votación | 30s, hasta que todos voten, o hasta mayoría matemática |
| Persistencia | Solo en memoria (sin DB) |
| Modo de juego | Landscape preferido, layout adaptativo |
| Fase de validación | Grid estilo Excel + botón Listo |

---

## Stack Tecnológico

- **Backend**: Node.js + Express + Socket.IO
- **Frontend**: HTML + CSS + Vanilla JS (responsive, mobile-first)
- **Hosting**: Render (free tier — Node.js web service)
- **Estado**: En memoria (no se necesita base de datos por ahora)

---

## Arquitectura General

```
stop/
├── server/
│   ├── index.js          # Entry point, Express + Socket.IO
│   ├── gameManager.js    # Lógica de salas y estado del juego
│   └── utils.js          # Normalización de texto (acentos, mayúsculas)
├── public/
│   ├── index.html        # SPA — toda la UI en una sola página
│   ├── style.css         # Diseño responsive, dark mode, animaciones
│   └── app.js            # Lógica del cliente, conexión Socket.IO
├── package.json
└── render.yaml           # Config de deploy para Render
```

---

## Flujo de la Aplicación (Pantallas / Estados)

```
[Pantalla de Bienvenida]
  → Ingresar apodo (guest)
  
[Lobby Principal]
  → Crear sala  →  [Sala como Host]
  → Ingresar código  →  [Sala como Guest]

[Sala de Espera]
  → Host: elige letras del abecedario (sin repetir)
  → Todos: ven la lista de letras elegidas
  → Todos: dan ✅ Listo
  → Host: presiona ▶ Iniciar (requiere ≥2 jugadores y ≥1 letra)
  
[Animación Ruleta]
  → Ruleta gira ~3s mostrando renglones sin revelar la letra
  → Se detiene → aparece la letra elegida (grande, dramático)
  → La letra queda visible en esquina superior derecha
  
[Ronda de Juego — 2 minutos]
  → Cada jugador rellena las 7 categorías
  → Botón STOP disponible en todo momento
  → Alguien presiona STOP o se acaba el tiempo → fin de ronda
  
[Fase de Validación]
  → Sistema marca automáticamente palabras repetidas
  → Cualquier jugador puede impugnar una palabra de otro
  → El resto vota: ✅ Válida / ❌ Inválida
  → Al terminar todas las votaciones → se calculan puntos
  
[Tabla de Puntajes (entre rondas)]
  → Ranking ordenado de mayor a menor puntaje acumulado
  → Host decide si jugar otra letra o terminar la partida
  
[Fin del Juego]
  → Se muestran todas las letras ya usadas (tachadas)
  → Ganador con animación
  → Botón: Volver al lobby
```

---

## Arquitectura de Archivos

```
stop/
├── package.json
├── render.yaml
├── server/
│   ├── index.js          # Express + Socket.IO, manejo de eventos
│   ├── gameManager.js    # Lógica de salas, puntuación, challenges
│   └── utils.js          # Normalización de texto
└── public/
    ├── index.html        # SPA con todas las pantallas
    ├── style.css         # Dark mode, glassmorphism, animaciones
    └── app.js            # Cliente Socket.IO, manejo de UI
```

---

## Componentes del Backend

### `gameManager.js` — Estado de Salas

```
Sala {
  id: string (código corto ej: "ABC123")
  host: socketId
  players: [ { id, name, ready, score } ]
  letters: string[]          // letras seleccionadas por el host
  usedLetters: string[]      // letras ya jugadas
  currentLetter: string
  state: 'waiting' | 'spinning' | 'playing' | 'validating' | 'scores'
  answers: { [playerId]: { [category]: string } }
  votes: { [wordKey]: { voters, result } }
  timer: NodeJS.Timeout
}
```

### Eventos Socket.IO

| Evento (cliente → server) | Descripción |
|---|---|
| `join_lobby` | El jugador entra con su apodo |
| `create_room` | Crea una sala nueva |
| `join_room` | Se une a una sala con código |
| `toggle_letter` | Host activa/desactiva una letra |
| `player_ready` | El jugador marca que está listo |
| `start_game` | Host inicia la partida |
| `submit_answers` | El jugador envía sus respuestas |
| `stop_round` | Un jugador presiona STOP |
| `challenge_word` | Un jugador impugna una palabra |
| `vote_word` | Jugador vota sobre una palabra impugnada |
| `next_round` | Host inicia la siguiente ronda |
| `end_game` | Host termina la partida |

| Evento (server → cliente) | Descripción |
|---|---|
| `room_state` | Estado completo de la sala |
| `player_joined` / `player_left` | Actualización de jugadores |
| `letters_updated` | Lista de letras actualizada |
| `game_starting` | Inicia animación de ruleta |
| `letter_chosen` | La letra de la ronda |
| `round_started` | Empieza el tiempo |
| `timer_tick` | Countdown cada segundo |
| `round_ended` | Alguien presionó STOP o tiempo agotado |
| `validation_phase` | Inicia la fase de votación |
| `word_challenged` | Una palabra fue impugnada |
| `vote_result` | Resultado de la votación |
| `scores_updated` | Puntajes finales de la ronda |
| `game_over` | La partida terminó |

### Lógica de Puntaje

- Sistema detecta automáticamente palabras repetidas (normaliza texto: sin acentos, sin mayúsculas, sin números)
- Palabra única y válida: **100 puntos**
- Palabra repetida entre ≥2 jugadores: **50 puntos** cada uno
- Palabra inválida (por voto): **0 puntos**
- Palabra vacía: **0 puntos**

### Normalización de Texto (`utils.js`)

```js
// Elimina acentos, convierte a minúsculas, elimina números
normalize(text) → string
// Valida que la palabra empiece por la letra correcta
startsWithLetter(word, letter) → bool
```

---

### Lógica de Votación de Palabras

- **Elegibles para votar**: todos los jugadores conectados EXCEPTO el jugador impugnado
- **Voto del impugnador**: pre-registrado automáticamente como ❌ Inválida
- **Resolución anticipada**: si una opción supera el 50% del total elegible
- **Tiempo límite**: 30 segundos por votación
- **Empate**: la palabra se considera **válida** (beneficio de la duda)
- **Caso especial (2 jugadores)**: el impugnador es el único elegible → resolución instantánea

---

## Componentes del Frontend

### Pantallas (estados del `app.js`)

1. **`screen-welcome`** — Input de apodo + botón entrar
2. **`screen-lobby`** — Crear sala / Unirse con código
3. **`screen-room`** — Sala de espera (letras, jugadores, controles)
4. **`screen-roulette`** — Animación de ruleta (canvas o CSS animation)
5. **`screen-game`** — Formulario de categorías + timer + botón STOP
6. **`screen-validation`** — Tabla de respuestas + votaciones
7. **`screen-scores`** — Ranking entre rondas
8. **`screen-gameover`** — Ganador final

### Categorías (columnas del formulario)

1. Nombre
2. Apellido
3. Cosa
4. Color
5. Animal
6. Ciudad o País
7. Película o Serie

### Grid de Validación (estilo Excel)

```
+----------------+----------+----------+----------+
| Categoría      | Alice    | Bob      | Carol    |
+----------------+----------+----------+----------+
| Nombre         | Ana  100 | Alberto  | Ana  50  |
| Apellido       | García   | —        | Gómez    |
| Cosa           | Avión    |⚖️Balón   | Automóvil|
| Color          | Azul     | Blanco   | Amarillo |
| Animal         | Abeja    | Burro    | Águila   |
| Ciudad o País  | Ámsterda.| Brasil   | Arabia   |
| Película/Serie | Avengers | Batman   |❌Barbie  |
+----------------+----------+----------+----------+
```

- **Celdas propias**: no clickeables (fondo sutil)
- **Celdas de otros**: clickeables → impugnar
- **Impugnadas**: ⚖️ amarillo
- **Invalidadas**: ❌ tachado/rojo
- **Validadas**: ✅ verde
- **Puntaje visible** bajo cada respuesta
- **Botón "Listo"**: todos deben presionarlo para finalizar la ronda
  - Si hay challenges pendientes, el Listo se registra pero la fase no cierra hasta que resuelvan

### Animación de Ruleta

- Canvas 2D o CSS animation pura
- Muestra renglones/slots en lugar de letras (misterio)
- Gira ~3 segundos con efecto de desaceleración (ease-out)
- Al parar: reveal dramático de la letra con animación de entrada

### Layout Mobile (Landscape)

**Problema**: En landscape, el teclado ocupa ~60% de la pantalla.

**Solución implementada**:
- En portrait: Header arriba → Form scrolleable → STOP abajo
- En landscape (`@media orientation: landscape`): Sidebar izquierdo fijo (Letra + Timer + STOP) + Form scrolleable a la derecha
- Al enfocar un input: auto-scroll suave al campo activo
- `visualViewport` API para detectar teclado y ajustar el contenedor del form
- Inputs con `autocapitalize="words"` para mejor UX móvil

### Diseño

- **Dark mode** como default
- Paleta: tonos oscuros con acentos vibrantes (gradiente azul-violeta)
- Responsive: mobile-first, funciona en pantallas desde 320px
- Tipografía: Google Fonts (Inter o Outfit)
- Micro-animaciones: hover en botones, entrada de pantallas, transiciones suaves

---

## Reglas de Negocio Importantes

- Máximo **10 jugadores** por sala
- Mínimo **2 jugadores** para iniciar
- Mínimo **1 letra** seleccionada para iniciar
- Las letras **no se pueden repetir** en la misma partida
- La partida termina cuando se juegan **todas las letras seleccionadas**
- El tiempo de una ronda es de **2 minutos**
- La ruleta tarda máximo **3 segundos**
- Letras disponibles: A-Z (sin Ñ por complejidad, aunque se puede agregar)

---

## Deploy en Render

- Tipo: **Web Service** (Node.js)
- Start command: `node server/index.js`
- Puerto: variable de entorno `PORT` (Render lo asigna automáticamente)
- Plan: **Free** (con advertencia de inactividad después de 15 min sin tráfico)
- `render.yaml` para configuración automática

> [!WARNING]  
> El plan free de Render "duerme" la instancia tras 15 minutos sin tráfico. El primer acceso puede tardar ~30 segundos en despertar. Para un juego activo esto no es un problema, pero conviene advertirle al jugador con un loader.

---

## Fases de Desarrollo

1. **Fase 1 — Backend Core**: Servidor, salas, Socket.IO, lógica del juego
2. **Fase 2 — Frontend Base**: Pantallas welcome, lobby, sala de espera
3. **Fase 3 — Juego en sí**: Ruleta, formulario de categorías, timer, STOP
4. **Fase 4 — Validación y Puntajes**: Lógica de votación, cálculo de puntos, ranking
5. **Fase 5 — Polish**: Animaciones, responsive, diseño final
6. **Fase 6 — Deploy**: Configurar Render, pruebas online

---

## Verificación

### Pruebas Manuales
1. Abrir dos pestañas → crear y unirse a sala
2. Completar un ciclo completo: letras → listo → iniciar → jugar → STOP → validar → puntajes
3. Probar desconexión durante la partida
4. Probar desde móvil (landscape y portrait)
5. Probar despliegue en Render

---

## Decisiones Anteriormente Abiertas — Resueltas

~~Preguntas Abiertas~~

- ~~Ñ~~ → **No incluir**
- ~~Desconexión~~ → **Jugador eliminado** (marcado como disconnected, se excluye de rondas futuras)
- ~~Tiempo de votación~~ → **30s / todos votan / mayoría matemática** (lo primero que ocurra)
- ~~Persistencia~~ → **Solo en memoria** por ahora
