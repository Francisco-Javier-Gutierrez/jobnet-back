import { sendStyledJobNetEmail, JobNetEmailOptions } from "../utils/emailTemplate";
import { sesClient } from "../handlers/applications/common";

const targetEmail = "franciscojavierg.h.051130@gmail.com";

interface ShowcaseCase {
  subject: string;
  options: JobNetEmailOptions;
}

const showcaseCases: ShowcaseCase[] = [
  // 1. INFO
  {
    subject: "1/6 [Info] Avance en Proceso: Contacto Directo Habilitado",
    options: {
      title: "Tu postulación avanza a la etapa de contacto directo",
      preheader: "TechCorp Solutions desea iniciar la fase de entrevistas técnicas contigo.",
      badgeText: "Avance en Proceso",
      badgeType: "info",
      recipientName: "Francisco Javier",
      paragraphs: [
        "¡Buenas noticias! El equipo de selección de <strong>TechCorp Solutions</strong> ha revisado tu perfil para la vacante <strong>Senior Cloud Solutions Architect</strong> y desea avanzar contigo a la fase de entrevistas técnicas.",
        "A partir de este momento tienes habilitado el canal de mensajería directa y chat en tiempo real dentro de tu panel de postulaciones para coordinar los detalles con el reclutador.",
      ],
      highlightBox: {
        title: "Mensaje del Reclutador",
        text: "Tu experiencia en arquitecturas Serverless y Terraform encaja a la perfección con nuestro stack tecnológico. Por favor responde por el chat para agendar la llamada técnica.",
        type: "info",
      },
      details: [
        { label: "Posición", value: "Senior Cloud Solutions Architect" },
        { label: "Empresa", value: "TechCorp Solutions" },
        { label: "Modalidad", value: "Remoto (Tiempo Completo)" },
        { label: "Estado", value: "En Contacto / Entrevista" },
      ],
      cta: {
        text: "Abrir Chat y Mis Postulaciones",
        url: "https://dsty3j5u0b31g.cloudfront.net/candidate/my-applications",
      },
      secondaryNotice:
        "Mantén activas tus notificaciones web para recibir avisos inmediatos cuando el reclutador te escriba.",
    },
  },

  // 2. PURPLE
  {
    subject: "2/6 [Seleccionado] ¡Has sido seleccionado para la vacante!",
    options: {
      title: "¡Felicidades! Has sido seleccionado para la vacante",
      preheader: "Innovatech Labs te ha seleccionado para la posición Staff Software Engineer.",
      badgeText: "Candidato Seleccionado",
      badgeType: "purple",
      recipientName: "Francisco Javier",
      paragraphs: [
        "¡Enhorabuena! Nos complace informarte que has sido seleccionado por <strong>Innovatech Labs</strong> para la posición <strong>Staff Software Engineer</strong>.",
        "Tu trayectoria, habilidades y desempeño en los retos técnicos sobresalieron entre todos los participantes del proceso de selección.",
      ],
      highlightBox: {
        title: "Siguiente Paso en el Proceso",
        text: "El departamento de Talento Humano se pondrá en contacto contigo en las próximas 24 horas para presentarte la propuesta económica formal y los beneficios asignados.",
        type: "info",
      },
      details: [
        { label: "Posición", value: "Staff Software Engineer" },
        { label: "Empresa", value: "Innovatech Labs" },
        { label: "Nivel de Rol", value: "Staff / Tech Lead" },
        { label: "Resolución", value: "Seleccionado para Propuesta" },
      ],
      cta: {
        text: "Revisar Estado en JobNet",
        url: "https://dsty3j5u0b31g.cloudfront.net/candidate/my-applications",
      },
      secondaryNotice:
        "Revisa periódicamente tu correo y tu buzón de mensajes directos en la plataforma.",
    },
  },

  // 3. SUCCESS
  {
    subject: "3/6 [Éxito] ¡Contratación Confirmada! Bienvenido al equipo 🎉",
    options: {
      title: "¡Contratación Confirmada! Bienvenido al equipo",
      preheader: "Es oficial: Has sido contratado en Fintech Global Inc.",
      badgeText: "¡Contratado! 🎉",
      badgeType: "success",
      recipientName: "Francisco Javier",
      paragraphs: [
        "¡Es oficial! Has completado con éxito todas las etapas del proceso de selección y has sido formalmente contratado para la vacante <strong>Lead DevOps Engineer</strong> en <strong>Fintech Global Inc.</strong>",
        "Todo el equipo de JobNet y Fintech Global te extendemos nuestra más sincera felicitación y te deseamos el mayor de los éxitos en esta nueva etapa profesional.",
      ],
      highlightBox: {
        title: "Coordinación de Onboarding",
        text: "El equipo de Recursos Humanos te contactará a la brevedad para la entrega de equipo de cómputo y la firma digital del contrato laboral.",
        type: "success",
      },
      details: [
        { label: "Puesto", value: "Lead DevOps Engineer" },
        { label: "Empresa", value: "Fintech Global Inc." },
        { label: "Tipo de Contrato", value: "Tiempo Indeterminado" },
        { label: "Estatus Final", value: "Contratación Exitosa" },
      ],
      cta: {
        text: "Ir a mi Panel de JobNet",
        url: "https://dsty3j5u0b31g.cloudfront.net/candidate/my-applications",
      },
      secondaryNotice: "¡Gracias por confiar en JobNet para impulsar tu desarrollo laboral!",
    },
  },

  // 4. WARNING
  {
    subject: "4/6 [Alerta] Aviso Oficial: Publicación Pausada para Revisión ⚠️",
    options: {
      title: "Aviso Preventivo: Vacante Pausada para Evaluación",
      preheader: "Tu publicación de empleo ha sido pausada de manera preventiva por moderación.",
      badgeText: "Revisión Requerida ⚠️",
      badgeType: "warning",
      recipientName: "Representante de Organización",
      paragraphs: [
        "Te notificamos que la publicación de empleo <strong>Desarrollador FullStack Senior</strong> ha sido pausada de manera preventiva por el equipo de moderación tras recibir reportes sobre presuntas discrepancias en las condiciones de la oferta.",
        "La vacante permanecerá oculta para nuevos postulantes mientras se desahoga el periodo de revisión y aclaración de evidencias.",
      ],
      highlightBox: {
        title: "Motivo del Reporte de Moderación",
        text: "Reporte de discrepancia entre el rango salarial publicado ($45,000 netos) y la propuesta informada al candidato en el canal de contacto ($18,000 sin prestaciones).",
        type: "warning",
      },
      details: [
        { label: "Publicación", value: "Desarrollador FullStack Senior" },
        { label: "Periodo de Gracia", value: "15 días naturales" },
        { label: "Límite para Apelar", value: "28 de Noviembre de 2026" },
        { label: "Procedimiento", value: "Apelación directa en Mis Vacantes" },
      ],
      cta: {
        text: "Ir a Mis Vacantes y Apelar",
        url: "https://dsty3j5u0b31g.cloudfront.net/recruiter/my-vacancies",
      },
      secondaryNotice:
        "Dispones del periodo de gracia para ingresar tus aclaraciones antes de que se emita un dictamen definitivo.",
    },
  },

  // 5. DANGER
  {
    subject: "5/6 [Descarte] Actualización sobre tu Postulación",
    options: {
      title: "Actualización sobre tu Postulación",
      preheader: "Nexus Innovations ha concluido la revisión de candidaturas para esta vacante.",
      badgeText: "Postulación Descartada",
      badgeType: "danger",
      recipientName: "Francisco Javier",
      paragraphs: [
        "Te informamos que el equipo de selección de <strong>Nexus Innovations</strong> ha concluido la revisión de candidaturas para la vacante <strong>Data Platform Engineer</strong> y en esta ocasión han decidido no avanzar con tu perfil.",
        "Agradecemos enormemente el tiempo, dedicación e interés que mostraste en participar en la convocatoria. Tu perfil permanecerá activo para futuras vacantes afines a tus competencias.",
      ],
      highlightBox: {
        title: "Motivo informado por el reclutador",
        text: "Se seleccionó un perfil con mayor especialización práctica en arquitecturas de streaming en tiempo real con Apache Flink y Delta Lake.",
        type: "danger",
      },
      details: [
        { label: "Posición", value: "Data Platform Engineer" },
        { label: "Empresa", value: "Nexus Innovations" },
        { label: "Estatus", value: "Proceso Concluido" },
      ],
      cta: {
        text: "Explorar Nuevas Vacantes",
        url: "https://dsty3j5u0b31g.cloudfront.net/vacancies",
      },
      secondaryNotice:
        "Te recomendamos continuar explorando nuevas oportunidades laborales que se adapten a tu perfil profesional.",
    },
  },

  // 6. GOLD
  {
    subject: "6/6 [Hito] ¡Alta Demanda Alcanzada en tu Vacante! 🔥",
    options: {
      title: "¡Hito de Alta Demanda Alcanzado! 🔥",
      preheader: "Tu vacante Tech Lead FullStack ha superado las 50 postulaciones.",
      badgeText: "Alta Demanda 🔥",
      badgeType: "gold",
      recipientName: "Equipo de Reclutamiento",
      paragraphs: [
        "¡Excelente alcance! Tu publicación de empleo <strong>Tech Lead FullStack</strong> ha alcanzado las <strong>50 postulaciones</strong> de candidatos en la plataforma.",
        "Te recomendamos ingresar a tu panel de reclutador para filtrar las postulaciones recibidas y comenzar el contacto con los candidatos más destacados.",
      ],
      highlightBox: {
        title: "Rendimiento de la Publicación",
        text: "Esta vacante tiene una tasa de postulación 3.8x superior al promedio de la categoría en los últimos 7 días.",
        type: "warning",
      },
      details: [
        { label: "Publicación", value: "Tech Lead FullStack" },
        { label: "Postulaciones Totales", value: "50 candidatos activos" },
        { label: "Tasa de Conversión", value: "Alta (Top 5% de la semana)" },
        { label: "Acción Recomendada", value: "Filtrar por Habilidades Clave" },
      ],
      cta: {
        text: "Gestionar Postulaciones en Panel",
        url: "https://dsty3j5u0b31g.cloudfront.net/company/vacancies",
      },
      secondaryNotice:
        "Gestionar ágilmente a los candidatos mejora la reputación de tu marca empleadora en JobNet.",
    },
  },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log(`🚀 Iniciando envío de showcase de correos JobNet a: ${targetEmail}`);
  console.log(
    `Total de correos a enviar: ${showcaseCases.length} con throughput de 20s entre cada uno.\n`,
  );

  for (let i = 0; i < showcaseCases.length; i++) {
    const item = showcaseCases[i];
    const num = i + 1;
    console.log(`[${num}/${showcaseCases.length}] Despachando: "${item.subject}"...`);

    try {
      const res = await sendStyledJobNetEmail({
        to: targetEmail,
        subject: item.subject,
        templateOptions: item.options,
        client: sesClient,
      });

      console.log(`  ✅ Correo ${num} enviado con éxito. MessageId: ${res.MessageId}`);
    } catch (err) {
      console.error(`  ❌ Error enviando correo ${num}:`, err);
    }

    if (i < showcaseCases.length - 1) {
      console.log(`  ⏳ Esperando 20 segundos antes del siguiente envío...\n`);
      await sleep(20000);
    }
  }

  console.log(
    `\n🎉 Showcase completado exitosamente. Los 6 correos fueron enviados a ${targetEmail}.`,
  );
}

run().catch((err) => {
  console.error("Error fatal en el runner:", err);
  process.exit(1);
});
