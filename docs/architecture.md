# Arquitectura de JobNet

## 1. Paradigma de Base de Datos

El proyecto utiliza un modelo **NoSQL** bajo el patrón **Single Table Design (STD)** en **Amazon DynamoDB**. Todas las entidades del sistema (Usuarios, Vacantes, Posts, Chats) coexisten en una única tabla física para maximizar la velocidad y minimizar los costos de lectura/escritura.

La separación lógica se logra mediante el uso estricto de Prefijos en la **Partition Key (PK)** y la **Sort Key (SK)**.

## 2. Modelado de Entidades (El Mapa STD)

| Dominio           | Entidad            | PK (Partition Key)           | SK (Sort Key)         | Atributos Principales                                                                                                                                                                       |
| ----------------- | ------------------ | ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identidad**     | Usuario/Perfil     | `USER#<userUuid>`            | `PROFILE`             | `tipoUsuario`, `email`, `nombre`, `fotoPerfil`, `biografia`, `enlacesWeb`, `documentosProfesionales`, `ubicacion`, `habilidades`, `organizacionVerificada`, `estadoCuenta`, `fechaCreacion` |
| **Identidad**     | Notificación       | `USER#<userUuid>`            | `NOTIF#<timestamp>`   | `notificationUuid`, `tipo`, `titulo`, `mensaje`, `leida`                                                                                                                                    |
| **Identidad**     | Post Guardado      | `USER#<userUuid>`            | `SAVE#<postUuid>`     | `fechaGuardado`, `postResumen`                                                                                                                                                              |
| **Transaccional** | Vacante            | `VACANCY#<vacancyUuid>`      | `METADATA`            | `empresaUuid`, `titulo`, `descripcion`, `modalidad`, `salario`, `habilidadesRequeridas`, `ubicacion`, `estado`, `fechaCreacion`                                                             |
| **Transaccional** | Postulación        | `VACANCY#<vacancyUuid>`      | `APP#<candidatoUuid>` | `applicationUuid`, `estado`, `urlCurriculumEnviado`, `fechaPostulacion`, `fechaActualizacion`                                                                                               |
| **Transaccional** | Sala Chat          | `CHAT#<chatUuid>`            | `METADATA`            | `vacanteUuid`, `empresaUuid`, `candidatoUuid`, `estado`                                                                                                                                     |
| **Transaccional** | Mensaje            | `CHAT#<chatUuid>`            | `MSG#<timestamp>`     | `messageUuid`, `emisorUuid`, `receptorUuid`, `contenido`                                                                                                                                    |
| **Social**        | Publicación        | `POST#<postUuid>`            | `METADATA`            | `autorUuid`, `contenido`, `multimedia`, `fechaCreacion`                                                                                                                                     |
| **Social**        | Comentario         | `POST#<postUuid>`            | `COMMENT#<timestamp>` | `commentUuid`, `autorUuid`, `contenido`                                                                                                                                                     |
| **Social**        | Like               | `POST#<postUuid>`            | `LIKE#<userUuid>`     | `fechaInteraccion`                                                                                                                                                                          |
| **Social**        | Compartido         | `POST#<postUuid>`            | `SHARE#<userUuid>`    | `fechaInteraccion`                                                                                                                                                                          |
| **Moderación**    | Catálogo Habilidad | `CATALOG#SKILLS`             | `SKILL#<skillUuid>`   | `nombre`, `categoria`, `fechaCreacion`                                                                                                                                                      |
| **Moderación**    | Incidencia         | `INCIDENT#<incidentUuid>`    | `METADATA`            | `denuncianteUuid`, `tipoEntidad`, `entidadUuid`, `motivo`, `estado`                                                                                                                         |
| **Moderación**    | Verificación       | `VERIFICATION#<empresaUuid>` | `METADATA`            | `urlDocumentoPDF`, `estado`, `fechaSolicitud`                                                                                                                                               |

---

## 3. Estructura de Atributos por Rol (El Payload)

Debido a la naturaleza esquemaless de DynamoDB, los registros solo almacenan los campos que necesitan.

- **Administrador Central:** `tipoUsuario` (ADMIN), `email`, `nombre`, `estadoCuenta`, `fechaCreacion`.
- **Moderador de Comunidad:** Mismos campos que el Admin, pero el `nombre` actúa como el alias público de soporte.
- **Empresa (Organización):** `tipoUsuario` (EMPRESA), `email`, `nombre` (Razón Social), `fotoPerfil` (Logotipo), `biografia` (Descripción corporativa), `enlacesWeb`, `ubicacion`, `organizacionVerificada` (Booleano), `estadoCuenta`, `fechaCreacion`.
- **Candidato:** `tipoUsuario` (CANDIDATO), `email`, `nombre`, `fotoPerfil`, `biografia` (Titular profesional), `enlacesWeb` (GitHub, Portafolio), `documentosProfesionales` (CV Formal), `ubicacion`, `habilidades` (Array de strings), `estadoCuenta`, `fechaCreacion`.

---

## 4. Ecosistema AWS y Conexiones (Arquitectura Serverless)

El flujo de los datos desde el frontend en Nuxt 3 hasta la persistencia y la búsqueda se conecta de la siguiente manera:

- **AWS Cognito (Autenticación y RBAC):** Controla el registro, el login y la seguridad. Mediante los "Cognito Groups", se inyecta el rol exacto (Candidato, Empresa, Moderador, Admin) directamente en los claims del token JWT. Esto permite autorización instantánea sin consultar la base de datos.
- **AWS API Gateway:** Funciona como la puerta de entrada. Decodifica el token de Cognito y bloquea peticiones no autorizadas antes de que lleguen al backend.
- **AWS Lambda:** Ejecuta la lógica de negocio (crear vacantes, registrar postulaciones, cambiar estatus) conectando el API Gateway con DynamoDB.
- **DynamoDB Streams:** El "tubo" de sincronización en tiempo real. Captura cualquier inserción o modificación en la tabla maestra (como una nueva vacante o actualización de un perfil) y dispara un evento automático.
- **AWS OpenSearch (Motor de Búsqueda):** Recibe los datos filtrados a través de DynamoDB Streams. Solo indexa información clave (títulos de vacantes, modalidades, habilidades requeridas, nombres de empresas) para garantizar filtros rápidos y económicos sin indexar campos pesados ni documentos.
- **AWS S3 (Almacenamiento de Objetos):** El repositorio estático donde aterrizan los logotipos, fotos de perfil, y donde se guardan estrictamente los CVs y Constancias de Situación Fiscal en formato PDF (con validación de límite de 5MB impuesta desde el backend).
