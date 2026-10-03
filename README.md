# Gcoin Guaraní backend

## Panel web

El panel se sirve desde `public/` al abrir `http://localhost:4000`. Sus solicitudes de API, incluidos registro e inicio de sesión, se envían a `https://gcoin-backend.onrender.com`; sirve la interfaz desde ese backend o desde otro origen con CORS habilitado. Incluye puntos del ciclo, el paisaje SVG cuyo caminante avanza con el progreso vigente, el mapa de hitos, el saldo de gemas y los nodos vinculados a la cuenta. La sesión web usa `sessionStorage` y el JWT expira a la hora.

El panel no simula heartbeats ni ofrece una conexión de wallet de blockchain: la dirección asociada a un nodo es un dato opcional. El agente del nodo debe enviar heartbeats con su token secreto mediante `X-Node-Token`.

La ruleta también se ejecuta desde este panel. La imagen proporcionada se guarda como `public/guarani-fondo.jpg` y se reutiliza tanto en el escenario de la ruleta como en el fondo de pantalla.

La cabecera muestra el ciclo día/noche según la hora de Paraguay, el saldo de gemas y el próximo hito de bonificación, con puntos sincronizados desde el servidor cada 10 segundos mientras la cuenta está abierta. El paisaje SVG incluye barcos de vela sobre el río, el personaje animado y rótulos de progreso cada 1.000 puntos hasta el límite del ciclo.

La tarjeta de puntos muestra el avance y porcentaje de la ventana móvil individual de 24 horas, cuyo límite de servidor es 11.000 puntos. La tarjeta de acumulado global consulta `networkStats` dentro de `GET /api/me/points`: suma los puntos históricos persistidos en `nodes.points` de todos los nodos y usuarios de esta instancia SQLite, e indica sus cuentas y nodos registrados. Cada heartbeat DePIN acreditado incrementa en una misma transacción el ciclo del propietario y el total histórico del nodo; por eso alcanzar el tope diario no dispara una transferencia adicional ni duplica puntos. Este acumulado no incluye premios de ruleta ni datos de otras instalaciones/servidores. La mención de TGE es una posibilidad de hoja de ruta, no un anuncio ni garantía.

El panel muestra una matriz visual de nueve espacios AURA con emblemas SVG, rellenada solo con los nodos que devuelve la API para la cuenta autenticada. El contrato actual de `GET /api/nodes` devuelve nombre, puntos y último heartbeat, pero no niveles ni multiplicadores AURA; la vista muestra esos campos solo si llegan de la API, sin inferir valores ni aplicar bonificaciones. El estado y la hora relativa del heartbeat se actualizan con la sincronización del panel cada 10 segundos.

La ruleta muestra iconografía SVG para cada premio y destaca el premio de 1.000 puntos. El banner publicitario reutiliza la imagen local `public/guarani-fondo.jpg` y ofrece accesos al espacio AdSense y a las recompensas DePIN. Las impresiones o clics publicitarios no acreditan puntos ni saldo retirable.

El panel de cuenta permite guardar la wallet de retiro y consultar solicitudes. Los retiros son solicitudes para revisión y pago manual; no se envían pagos automáticamente.

El panel incluye un código QR que abre `https://gcoin.depinguarani.com/` y puede instalarse como PWA desde un navegador compatible. El manifiesto y el service worker permiten abrir la interfaz básica sin conexión; las operaciones de cuenta y nodos siguen requiriendo conexión al servidor. La instalación requiere servir el sitio por HTTPS (o desde `localhost`). El QR se obtiene desde QRServer y requiere conexión para cargarse.

## Configuración

Requiere Node.js y las dependencias de `package.json`. Antes de iniciar el servidor, configura `JWT_SECRET` con un valor secreto aleatorio de al menos 32 bytes. No guardes ese valor en el repositorio.

En PowerShell:

```powershell
$env:JWT_SECRET = "<secreto-aleatorio-de-al-menos-32-bytes>"
$env:PORT = "4000"
$env:DB_PATH = ".\gcoin_guarani.db"
$env:USD_PER_DEPIN_POINT = "0.001"
$env:SMTP_HOST = "smtp.example.com"
$env:SMTP_PORT = "587"
$env:SMTP_SECURE = "false"
$env:SMTP_USER = "<usuario-smtp>"
$env:SMTP_PASS = "<secreto-smtp>"
$env:SMTP_FROM = "<remitente-verificado>"
$env:ADMIN_EMAIL = "<correo-de-administracion>"
node server.js
```

`PORT` y `DB_PATH` son opcionales. Si no se define `DB_PATH`, se usa `./gcoin_guarani.db` relativo al directorio de inicio del proceso.

`USD_PER_DEPIN_POINT` es una tarifa opcional expresada en USD por punto DePIN y admite hasta seis decimales. **No la configures hasta aprobar la conversión económica real del proyecto.** Si falta o no es válida, el backend no acredita saldo monetario ni permite solicitar retiros. El ejemplo `0.001` es solo ilustrativo y no implica una tarifa recomendada. SMTP requiere todas las variables indicadas; guarda sus secretos únicamente en el entorno del servidor, nunca en el repositorio. Sin SMTP, las solicitudes no se aceptan.

## Autenticación y nodos

- `POST /register`: crea una cuenta y devuelve un JWT de acceso de una hora. Acepta `username`, `password` (entre 8 y 256 caracteres) y el opcional `referredBy`. Las contraseñas nuevas se almacenan con scrypt. Las contraseñas antiguas en texto plano se convierten a scrypt después de un inicio de sesión válido.
- `POST /login`: acepta `username` y `password`, y devuelve un JWT.
- Las rutas de cuenta y gestión de nodos requieren `Authorization: Bearer <jwt>`.
- `POST /api/nodes`: registra un nodo de la cuenta autenticada. Acepta `nodeName` y el opcional `walletAddress`. Devuelve una sola vez el secreto `nodeToken`; el servidor solo almacena su hash.
- `GET /api/nodes`: lista los nodos de la cuenta autenticada, sin revelar tokens.
- `POST /api/nodes/:id/rotate-token`: invalida el token previo y devuelve un token nuevo para un nodo del propietario autenticado.
- `POST /api/nodes/heartbeat`: requiere `X-Node-Token: <nodeToken>`. El nodo debe enviar un heartbeat aproximadamente cada minuto.
- `GET /api/me/points`: devuelve los puntos del ciclo actual, los puntos acumulados por los nodos de la cuenta y la próxima fecha de reinicio.
- `POST /api/roulette/spin`: requiere el JWT de usuario y un `Idempotency-Key` UUID. El servidor sortea el premio, registra el resultado y acredita los puntos dentro de una transacción; el cliente nunca envía el premio ni la cantidad de puntos.
- `GET /api/me/wallet` y `PUT /api/me/wallet`: consultan o guardan la wallet de retiro de la cuenta autenticada; la identidad se toma del JWT, no del cuerpo de la solicitud.
- `GET /api/me/withdrawals`: devuelve las solicitudes de retiro de la cuenta autenticada.
- `POST /api/me/withdrawals`: reserva el saldo monetario DePIN disponible completo al alcanzar el mínimo de $5 USD, crea una solicitud pendiente y envía un correo de aviso al administrador. No procesa ni confirma un pago.
- `POST /api/me/withdrawals/:id/notify`: reintenta el aviso SMTP de una solicitud pendiente si el envío inicial falló. No duplica solicitudes ni vuelve a reservar saldo.

## Cálculo y ciclo de puntos

El cliente no envía una cantidad de puntos. El servidor calcula el crédito a partir del tiempo transcurrido entre heartbeats consecutivos:

`puntos = minutos verificados × 7,64`

El primer heartbeat solo establece la referencia temporal. Se acredita el intervalo siguiente únicamente si el último heartbeat fue recibido hace no más de dos minutos; los intervalos más largos no generan puntos y el heartbeat recibido vuelve a establecer la referencia.

El límite de **11.000 puntos es compartido por todos los nodos de una misma cuenta**. El primer intervalo que genera puntos inicia una ventana móvil de 24 horas, anclada al heartbeat inmediatamente anterior a ese intervalo; al cumplirse esas 24 horas se reinicia el contador. Al llegar al tope, los heartbeats siguen actualizando la referencia, pero no otorgan puntos adicionales en ese ciclo. Los puntos de cada nodo se acumulan en `nodes.points`; `users.points_today` registra el total de la cuenta en el ciclo vigente.

Los heartbeats acreditan presencia periódica del nodo; no prueban por sí solos que el nodo esté ejecutando un trabajo computacional específico. Solo los puntos acreditados directamente por estos heartbeats generan saldo retirable, usando la tarifa USD configurada. Los puntos de la ruleta, las gemas y las visualizaciones/clics publicitarios no generan saldo monetario.

## Ruleta y límites de premios

La cuenta puede realizar hasta **15 giros por ventana móvil de puntos de 24 horas**. El sorteo se efectúa en el backend con `crypto.randomInt`; cada resultado se registra en `roulette_spins` y la clave idempotente impide duplicar una misma solicitud reintentada. Los premios son **10 puntos (45%)**, **30 (30%)**, **50 (15%)**, **100 (9,9%)** y **1.000 (0,1%)**. Si queda menos saldo diario que el premio sorteado, se acredita únicamente el remanente hasta el tope compartido de 11.000 puntos. Los puntos de la ruleta pueden completar hitos y activar sus gemas.

Los anuncios de AdSense se muestran en un espacio independiente. Ni una impresión ni la visualización de un anuncio son comprobadas o requeridas para girar o recibir un premio.

## Hitos y gemas

Al acreditar puntos, el servidor comprueba si el usuario cruzó alguno de estos hitos del ciclo: **1.000 = 5 gemas**, **3.000 = 20**, **5.000 = 50**, **7.000 = 100** y **9.000 = 200**. El premio se acredita automáticamente una sola vez por cuenta. El navegador solo presenta el saldo y los hitos confirmados por la API; no puede asignarse gemas por una solicitud del cliente.

`users.gems_balance` guarda el saldo acumulado. `gem_milestones` conserva una fila por cuenta e hito para hacer el premio idempotente, incluso si el proceso reintenta una transacción o la cuenta completa otros ciclos de puntos.

## Datos y migraciones

El servidor crea o amplía estas tablas de `gcoin_guarani.db` al iniciar:

- `users`: identidad y credenciales (`id`, `username`, `password`, `gcoins`, `created_at`, `referred_by`), puntos del ciclo (`points_today`, `points_cycle_started_at`) y saldo de gemas (`gems_balance`).
- `nodes`: identidad y wallet (`id`, `node_name`, `wallet_address`, `created_at`), puntos acumulados (`points`), propietario (`owner_user_id`), credencial del nodo (`token_hash`) y referencia temporal (`last_heartbeat_at`).
- `gem_milestones`: registro idempotente de cada premio (`user_id`, `milestone_points`, `gems_awarded`, `achieved_at`).
- `roulette_spins`: auditoría de ruletas (`user_id`, `request_id`, `cycle_started_at`, resultado aleatorio, premio sorteado, puntos acreditados, saldo antes/después y `created_at`).
- `users.payout_wallet_address` y `users.payout_balance_microusd`: wallet de retiro y saldo pendiente en unidades enteras de micro-USD, para evitar errores de precisión decimal.
- `withdrawal_requests`: registro de retiros (`user_id`, `amount_microusd`, `wallet_snapshot`, `status`, estado/error de notificación y fechas). Al crear una solicitud, el saldo se reserva dentro de la misma transacción y la wallet se guarda como instantánea; el estado queda `PENDING` hasta su revisión manual.

Las migraciones agregan las columnas faltantes sin borrar las columnas existentes. Los nodos preexistentes sin propietario ni token no pueden enviar heartbeats; deben registrarse nuevamente mediante una cuenta autenticada.
