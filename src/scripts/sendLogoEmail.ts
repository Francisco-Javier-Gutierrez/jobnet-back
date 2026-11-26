import { sendStyledJobNetEmail } from "../utils/emailTemplate";

async function main() {
  const targetEmail = "franciscojavierg.h.051130@gmail.com";
  console.log(`Enviando correo con Logo PNG Oficial a: ${targetEmail}...`);

  const res = await sendStyledJobNetEmail({
    to: targetEmail,
    subject: "✨ Logotipo Oficial JobNet en Alta Definición (PNG)",
    templateOptions: {
      title: "Logotipo Oficial PNG Implementado",
      badgeText: "Identidad Visual",
      badgeType: "purple",
      recipientName: "Francisco Javier",
      paragraphs: [
        "El isotipo estilizado ha sido sustituido exitosamente por el <strong>Logotipo PNG Oficial</strong> de JobNet.",
        "El activo se sirve a través de la red de distribución global CloudFront con renderizado y compresión de alta fidelidad, asegurando compatibilidad completa en Gmail, Apple Mail y Outlook.",
      ],
      details: [
        { label: "Activo Gráfico", value: "logotipo.png (PNG 24-bit con transparencia)" },
        { label: "Distribución CDN", value: "https://dsty3j5u0b31g.cloudfront.net/logotipo.png" },
        { label: "Compatibilidad", value: "100% de clientes de correo sin bloqueo de SVG" },
        { label: "Ruta de Solicitudes", value: "/candidate/my-applications" },
      ],
      highlightBox: {
        title: "Visualización en Bandeja",
        text: "Comprueba el encabezado: el isotipo con el degradado azul-verde de JobNet se muestra nítido y en proporciones exactas junto al texto institucional.",
        type: "info",
      },
      cta: {
        text: "Ver Mis Postulaciones",
        url: "https://dsty3j5u0b31g.cloudfront.net/candidate/my-applications",
      },
    },
  });

  console.log(`✅ Correo enviado con éxito. MessageId: ${res.MessageId}`);
}

main().catch((err) => {
  console.error("Error al enviar correo con logo:", err);
  process.exit(1);
});
