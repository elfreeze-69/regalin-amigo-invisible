# Regalín — amigo invisible online 🎁

Web completa para organizar un **amigo invisible entre distintos móviles**. El organizador crea una sala; comparte un código o un enlace; el grupo se une con su nombre; finalmente realiza un sorteo **secreto, sin nombres repetidos ni personas asignadas a sí mismas**. Cada participante descubre solamente su propio resultado.

## Funciones

- Crear una sala con nombre, presupuesto opcional y fecha de entrega opcional.
- Unirse con un **código de 6 caracteres** o con el enlace de invitación.
- Ver la lista de participantes, actualizada automáticamente cada 5 segundos.
- Hasta **30 personas** por sala. Un nombre de participante no se puede repetir en la misma sala.
- Solo quien creó la sala puede iniciar el sorteo, y se necesitan al menos dos personas.
- Nadie se asigna a sí mismo: el sorteo mezcla los participantes y los organiza en un ciclo aleatorio.
- Los emparejamientos son **privados**: cada persona ve solo su propio resultado; ni siquiera el organizador puede ver los demás.
- Al cerrar la sala con el sorteo, ya no se admiten nuevas inscripciones. No se puede volver a sortear.
- El acceso privado de cada participante se guarda en su navegador para seguir entrando desde el mismo dispositivo.
- Funciona en iPhone, Android, ordenadores y tabletas.

## 📱 Publicar GRATIS desde iPhone (sin ordenador ni consola)

Este proyecto tiene despliegue automático de base de datos y creación de tablas en la primera petición.

1. En Safari, abre [GitHub — crear repositorio](https://github.com/new). Ponle `regalin-amigo-invisible`, que sea **Public**, créalo sin README inicial, y **pasa su URL a ChatGPT**. Con GitHub conectado a ChatGPT, el asistente puede subir los archivos directamente al repositorio. **No subas el ZIP como un único archivo**: Cloudflare tiene que ver `src`, `public`, `wrangler.jsonc` y `package.json` en la raíz del repositorio.
2. Una vez subido el proyecto, entra en `https://deploy.workers.cloudflare.com/?url=https://github.com/USUARIO/regalin-amigo-invisible` sustituyendo `USUARIO` por tu usuario de GitHub. O en [Cloudflare Workers](https://dash.cloudflare.com/) elige **Workers & Pages → Create → Import a repository** y selecciona el repositorio.
3. Inicia sesión en Cloudflare, selecciona el plan **Free**, autoriza acceso al repositorio si se solicita y pulsa **Deploy** (comando `npx wrangler deploy` si te lo pide). Workers provisionará automáticamente una base D1 enlazada a `DB`.
4. La primera petición a `/api/` inicializa las tablas, sin comandos SQL ni terminal. Comparte el enlace `*.workers.dev` que te proporciona Cloudflare.

**Importante:** necesitarás una cuenta en GitHub y otra en Cloudflare; ambas pueden ser gratuitas. El límite diario del plan gratuito es suficiente para un grupo pequeño. El panel de Cloudflare es menos cómodo en Safari móvil: utiliza **aA → Solicitar sitio web para ordenador** si un botón no aparece.

## Cómo probar en tu ordenador

Necesitas **Node.js 20 o posterior** y una conexión a Internet para instalar Wrangler.

1. Abre una terminal dentro de esta carpeta.
2. Ejecuta:
   ```bash
   npm install
   npm run db:local
   npm run dev
   ```
3. Abre la dirección que muestre Wrangler, normalmente `http://localhost:8787`.
4. Crea una sala y abre otra ventana privada del navegador para unirte con otro nombre.

> El archivo `public/index.html` es solo la parte visual. Para crear salas y realizar sorteos necesitas el servidor incluido en `src/index.js` y la base de datos D1. Abrir el HTML por separado no permite jugar entre varios móviles.

## Cómo publicarla para que todos puedan entrar

Este proyecto está preparado para **Cloudflare Workers + D1**. Si dispones de un ordenador, también puedes utilizar Node.js y ejecutar los comandos siguientes. **Con el método para móvil de arriba no necesitas Node.js ni consola.**

1. Crea una cuenta en [Cloudflare](https://dash.cloudflare.com/sign-up).
2. Instala dependencias en la carpeta del proyecto:
   ```bash
   npm install
   ```
3. Conecta tu cuenta:
   ```bash
   npx wrangler login
   ```
   Se abrirá una página para autorizar Wrangler.
4. Crea la base de datos:
   ```bash
   npx wrangler d1 create amigo-invisible-db
   ```
5. Opcional: **no necesitas añadir `database_id`**, porque la configuración permite que Wrangler aprovisione D1 automáticamente al desplegar. Si la base ya existe, usa su ID para enlazarla de forma explícita.
6. Aplica las tablas a la base de datos pública:
   ```bash
   npm run db:remote
   ```
7. Publica la web:
   ```bash
   npm run deploy
   ```
8. Al finalizar, Wrangler mostrará tu dirección pública, normalmente `https://regalin-amigo-invisible.<tu-subdominio>.workers.dev`. **Esa es la web que puedes mandar a tus amigos.**

Después podrás volver a ejecutar `npm run deploy` cuando hagas cambios. El contenido de las salas permanece en D1, no depende de tu ordenador.

## Privacidad y límites

- Cada persona recibe un token secreto aleatorio de 256 bits. El servidor solo almacena su *hash* SHA-256, no el token en claro.
- La lista de nombres es visible a quienes conozcan el código. Los emparejamientos **no** se envían en la lista de participantes y para consultar uno se necesita el token privado de esa persona.
- El token se guarda en el almacenamiento local del navegador. Si se borra el almacenamiento, se utiliza un navegador privado distinto o se cambia de móvil, **no se puede recuperar la asignación automáticamente**. Para la primera versión, es mejor continuar desde el mismo navegador. No envíes tu token a nadie.
- No se necesita proporcionar correo, contraseña ni número de teléfono.
- El código es una invitación; compártelo solo con tu grupo. Para un sitio público con mucho tráfico se recomienda configurar medidas antiabuso / limitación de peticiones en Cloudflare.
- Las salas no caducan ni se borran automáticamente en esta versión. La persona titular de Cloudflare puede administrar la base de datos.
- Este proyecto **no se ha publicado automáticamente**: los pasos de despliegue requieren que conectes tu propia cuenta de Cloudflare.

## Archivos

- `public/index.html` — interfaz.
- `public/styles.css` — diseño adaptable a móvil.
- `public/app.js` — interacción, estado de la sala y resultados privados.
- `src/index.js` — API que valida inscripciones y ejecuta el sorteo.
- `migrations/0001_initial.sql` — tablas y restricciones de D1.
- `wrangler.jsonc` — configuración de despliegue.
- `tests/worker.test.mjs` — pruebas automáticas de las reglas del sorteo.

## API resumida

| Método | Ruta | Para qué sirve |
|---|---|---|
| `POST` | `/api/rooms` | Crea una sala y registra al organizador |
| `GET` | `/api/rooms/:code` | Devuelve datos de sala y nombres de participantes |
| `POST` | `/api/rooms/:code/join` | Une a una nueva persona |
| `GET` | `/api/rooms/:code/me` | Comprueba la identidad privada del participante |
| `POST` | `/api/rooms/:code/draw` | Realiza el sorteo; solo organizador |
| `GET` | `/api/rooms/:code/reveal` | Obtiene **solo** el destinatario del token autenticado |

Las rutas autenticadas utilizan `Authorization: Bearer <token>`.
