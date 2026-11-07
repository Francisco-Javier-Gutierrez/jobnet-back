# Reglas del Proyecto y Flujos de Trabajo (JobNet Backend)

¡Bienvenido al backend de JobNet! Para mantener la máxima calidad de código, prevenir vulnerabilidades de seguridad y asegurar despliegues confiables hacia AWS (Lambda, DynamoDB, API Gateway, S3, Cognito), hemos establecido una serie de estándares estrictos, candados de seguridad en Git y pipelines automatizados de CI/CD.

Por favor, lee con detenimiento este documento antes de programar o modificar cualquier componente del backend.

---

## 1. Ramas y GitFlow

- **`develop`**: Es la rama base de integración. **Todos los despliegues automáticos** de desarrollo/staging ocurren cuando se hace un merge hacia esta rama.
- **`main`**: Es la rama blindada de producción. **Está terminantemente prohibido hacer push directo a `main`**.
  - La rama `main` solo puede recibir actualizaciones automáticas aprobadas por el pipeline de auditoría de Jenkins (`npm run jenkins`), el cual inyecta la variable de entorno de autorización `JENKINS_GATEKEEPER_APPROVED=true`.
- **Ramas de trabajo**: Crea siempre ramas partiendo de `develop` con la nomenclatura:
  - `feature/nombre-de-la-feature`
  - `fix/nombre-del-error`
- **Creación de Pull Requests (PR)**:
  - **Los PRs se deben hacer siempre con destino a `develop` y nunca a `main`**.
  - Si el dispositivo cuenta con la CLI de GitHub (`gh`), crea el PR automáticamente mediante `gh pr create --base develop`.
- **Aislamiento Estricto de Ramas Mock y Datos de Prueba**:
  - Las ramas de datos simulados (e.g. `feature/mock-*`) son exclusivamente para sus ramas aisladas.
  - **JAMÁS deben ser mergeadas ni a `develop` ni a `main`**.

---

## 2. Git Hooks de Protección (`.githooks`)

Para garantizar que ningún código roto o vulnerable ingrese al repositorio, el backend cuenta con Git Hooks automáticos:

1. **`pre-commit`**:
   - Se ejecuta antes de generar cualquier commit local.
   - Dispara automáticamente `npm run check`. Si el linter, los tipos, el formato o las pruebas fallan, el commit es abortado de inmediato.
2. **`pre-push`**:
   - Valida el destino del push. Si el desarrollador intenta hacer `git push origin main`, el hook bloquea la operación e indica que debe ejecutarse `npm run jenkins`.
   - Ejecuta `npm run check` para revalidar la integridad del código antes de subirlo a GitHub.

Para activar los hooks localmente (se configura automáticamente al clonar/instalar):

```bash
git config core.hooksPath .githooks
# O mediante el comando de npm:
npm run prepare
```

---

## 3. Jenkins Quality Gatekeeper (`npm run jenkins`)

Para publicar cambios a producción en la rama `main`:

```bash
npm run jenkins
```

Este comando ejecuta de forma automatizada:

1. **Validación local estricta**: corre `npm run check` (Prettier, ESLint, TypeScript, Vitest y Build).
2. **Auto-commit y push a `develop`**: sincroniza la rama `develop` en GitHub con un push seguro (`--force-with-lease`).
3. **Disparo del Pipeline en Jenkins Docker**:
   - Conecta con `http://localhost:8080/job/jobnet-back`.
   - Monitorea la cola y la ejecución de la auditoría en tiempo real.
4. **Promoción Segura a `main`**:
   - Si Jenkins aprueba todas las etapas (`SUCCESS`), desbloquea el candado `JENKINS_GATEKEEPER_APPROVED=true` y hace push a `origin main`.
   - Si Jenkins detecta cualquier error, la rama `main` permanece intacta y protegida.

---

## 4. Validaciones de Entrada y Seguridad Estricta (Zod & Validator)

Tras las auditorías de seguridad del sistema, todas las Lambdas deben aplicar validación estricta de datos:

### A. Uso Obligatorio de `src/utils/validator.ts` y Zod

- **Cero `JSON.parse` desprotegidos**: Queda prohibido hacer `JSON.parse(event.body || "{}")` sin protección `try/catch`. Debe utilizarse siempre `parseJsonBody(event.body)` o `validateAndParse(schema, event.body)`, retornando `400 Bad Request` ante JSON inválido en lugar de generar un error 500 no controlado.
- **Validación de Parámetros y Payloads**: Toda entrada proveniente de `queryStringParameters`, `pathParameters` o `body` debe ser validada contra esquemas de Zod antes de interactuar con DynamoDB o servicios externos.
- **Helper schemas reutilizables**:
  - `safeIdSchema`: Valida identificadores alfanuméricos seguros y UUIDs (evita inyecciones de clave en DynamoDB).
  - `safeText(min, max)`: Valida cadenas sin caracteres peligrosos o tamaños desmedidos.
  - `nonNegativeNumber`, `positiveInteger`: Valida métricas y paginaciones.

### B. Autenticación y Autorización (`extractAuthContext`)

- **Prohibido el bypass de desarrollo en producción**: No se permite escribir `if (!callerId) { // dummy fallback }` en handlers accesibles públicamente.
- **Detección de Roles Confiable**:
  - La verificación de identidad debe realizarse mediante `extractAuthContext(event)` leyendo los claims de Cognito (`authorizer.claims`).
  - La cabecera `x-user-role` solo está permitida en entorno local offline (`IS_OFFLINE === "true"`). En producción debe ser ignorada para evitar suplantación de privilegios (Role Spoofing).
- **Protección de Endpoints Críticos**:
  - Endpoints administrativos (`/admin/*`) y de moderación (`/moderator/*`) deben verificar explícitamente el rol (`ADMIN` o `MODERATOR`) y rechazar peticiones no autorizadas con `403 Forbidden` o `401 Unauthorized`.

---

## 5. Reglas de Arquitectura y Base de Datos (DynamoDB & Serverless)

### A. Single Table Design (STD)

- **Tabla Única**: Todas las entidades del dominio (Usuarios, Vacantes, Chats, Publicaciones, Notificaciones, Reportes) coexisten en la misma tabla de DynamoDB.
- **Estructura de Claves**:
  - **PK (Partition Key)**: Prefijo de la entidad (ej. `USER#<uuid>`, `VACANCY#<uuid>`, `CHAT#<uuid>`, `POST#<uuid>`).
  - **SK (Sort Key)**: Sub-entidad o tipo de registro (`PROFILE`, `METADATA`, `MSG#<timestamp>`, `LIKE#<userId>`).
  - **GSIs**: Utilizar `GSI1PK`, `GSI1SK`, `GSI2PK`, `GSI2SK` para consultas secundarias indexadas.
- **Ausencia de Atributos Nulos**: En DynamoDB no se deben almacenar propiedades con valor `null`, `undefined` o cadenas vacías `""`. Si un atributo opcional no existe, omítelo del objeto.

### B. Puertos de Desarrollo Local (Serverless Offline)

Para evitar colisiones de puertos (`EADDRINUSE`) al ejecutar simultáneamente el frontend, REST API y WebSockets:

- **API REST (HTTP)**: Puerto `3001`
- **WebSockets API**: Puerto `3002`
- **Lambda Engine**: Puerto `3003`

---

## 6. Resumen de Comandos de Calidad

Antes de hacer commit o push, asegúrate de que el ciclo de calidad se ejecute sin advertencias ni errores:

```bash
# Verificación unificada obligatoria:
npm run check

# Comandos individuales:
npm run format:check   # Verifica el estilo de código con Prettier
npm run format         # Auto-formatea todos los archivos
npm run lint           # Ejecuta ESLint
npm run typecheck      # Valida tipos de TypeScript sin emitir archivos
npm run test           # Ejecuta la suite de pruebas unitarias con Vitest
npm run test:coverage  # Ejecuta pruebas y reporte de cobertura v8
npm run build          # Compila TypeScript a JavaScript
```
