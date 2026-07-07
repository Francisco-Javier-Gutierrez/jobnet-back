# Reglas del Proyecto y Flujos de Trabajo (JobNet)

¡Bienvenido al equipo! Para mantener una alta calidad de código y asegurar que los despliegues sean estables, hemos implementado una serie de reglas estrictas y flujos de integración continua (CI/CD) que todos los desarrolladores deben seguir.

Por favor, lee con detenimiento este documento antes de comenzar a programar.

---

## 1. Ramas y GitFlow

- **`develop`**: Es la rama base de integración. **Todos los despliegues automáticos** (hacia el entorno de desarrollo/testing) ocurren cuando se hace un merge hacia esta rama.
- **`main`**: Actualmente está **deshabilitada para despliegues automáticos**. No hagas merge a `main` a menos que se indique explícitamente para una versión de producción oficial.
- **Ramas de trabajo**: Crea siempre ramas partiendo de `develop` con los prefijos:
  - `feature/nombre-de-la-feature`
  - `fix/nombre-del-error`

---

## 2. Integración Continua (CI)

Hemos configurado un Action de GitHub (`ci.yml`) que se dispara automáticamente cuando haces `push` a una rama `feature/*` o `fix/*`, y al abrir un Pull Request hacia `develop` o `main`.

El CI ejecutará una serie de validaciones secuenciales. **Si tu código falla en alguna de ellas, el Pull Request será bloqueado.**

Para asegurarte de que tu código pasará el CI, puedes (y debes) ejecutar los siguientes comandos localmente antes de hacer push:

### A. Formato de Código (Prettier)

Usamos **Prettier** para estandarizar el formato de todos los archivos y evitar discusiones sobre estilos.

- Para verificar el formato: `npm run format:check`
- Para arreglar todos los archivos automáticamente: `npm run format` (Haz esto antes del commit).

### B. Linting (ESLint)

Usamos **ESLint** para detectar malas prácticas y errores lógicos en el código.

- Comando: `npm run lint`
- Todos los errores de linter deben ser resueltos. No silencies reglas globales a menos que haya una justificación arquitectónica aprobada.

### C. Tipado Estricto (TypeScript)

El proyecto usa TypeScript de forma estricta. No se permite el uso de variables sin tipar ni el abuso excesivo de `any`.

- Comando frontend: `npm run typecheck` (`vue-tsc --noEmit`)
- Comando backend: `npm run typecheck` (`tsc --noEmit`)
- El CI fallará si existen errores de tipos.

### D. Pruebas Unitarias y Cobertura (Vitest)

Hemos configurado **Vitest** con un umbral de cobertura estricto.

- **Cobertura requerida: 100%**.
- Esto incluye **Líneas, Funciones, Ramas (if/else) y Declaraciones (Statements)**.
- Todas las funciones (backend) y componentes importantes (frontend) deben contar con su respectivo archivo de prueba (`.test.ts` o `.spec.ts`).
- Comando para ejecutar las pruebas: `npm run test`
- Comando para verificar la cobertura localmente: `npm run test:coverage`

### E. Construcción (Build)

El último paso del CI valida que la aplicación compile correctamente sin errores.

- Comando: `npm run build`

---

## 3. Resumen de comandos antes de hacer Push

Antes de subir tus cambios a GitHub, acostúmbrate a correr este ciclo en tu terminal:

```bash
npm run format
npm run lint
npm run typecheck
npm run test:coverage
npm run build
```

Si todo sale verde, ¡tu código está listo para revisión y posterior despliegue automático a `develop`!

---

## 4. Reglas de Arquitectura y Base de Datos (DynamoDB & Cognito)

Para asegurar la integridad de la base de datos y la consistencia de los datos en JobNet, se deben seguir las siguientes directrices arquitectónicas:

### A. Paradigma NoSQL y Single Table Design (STD)
* **Tabla Única**: Todas las entidades (Usuarios, Vacantes, Chats, Publicaciones, Notificaciones) coexisten en la misma tabla física de DynamoDB.
* **Prefijos de Claves**:
  - **Partition Key (PK)**: Debe tener siempre el formato prefijado de la entidad (ej. `USER#<userUuid>`, `VACANCY#<vacancyUuid>`, `CHAT#<chatUuid>`, `POST#<postUuid>`).
  - **Sort Key (SK)**: Debe definir lógicamente la partición (ej. `PROFILE` para el perfil, `METADATA` para configuraciones, `MSG#<timestamp>` para mensajes).
* **Ausencia de Campos Nulos**: Debido a que DynamoDB es NoSQL sin esquema rígido, **no se deben guardar campos vacíos o nulos** en la base de datos. Si un atributo no le pertenece a un rol o está vacío, simplemente no debe existir en su registro.

### B. Mapeo de Roles de Usuario y Cognito Groups
* Al confirmar un registro, la Lambda `postConfirmation` normaliza los roles y asigna el usuario a su respectivo grupo en Cognito (`ADMIN`, `MODERATOR`, `EMPRESA`, `CANDIDATO`).
* Si el rol proviene de campos como `custom:role` (ej. `'company'`, `'candidate'`), debe mapearse y traducirse de forma estricta a los grupos en mayúsculas de AWS Cognito y DynamoDB (`EMPRESA`, `CANDIDATO`).

### C. Desarrollo Local con Serverless Offline
* Para evitar errores del tipo `EADDRINUSE`, la configuración local debe mantener estrictamente separados los puertos de la siguiente forma:
  - **HTTP:** Puerto `3001`
  - **Websockets:** Puerto `3002`
  - **Lambda Port:** Puerto `3003` (especificado en `lambdaPort` para evitar conflictos entre REST y Websockets).

