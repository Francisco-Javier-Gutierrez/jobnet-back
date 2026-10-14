import webpush from "web-push";
import fs from "fs";
import path from "path";

const subPath = path.resolve(process.cwd(), "..", ".push-subscription.json");
if (!fs.existsSync(subPath)) {
  console.error("No se encontró el archivo de suscripción en:", subPath);
  process.exit(1);
}

const subscription = JSON.parse(fs.readFileSync(subPath, "utf-8"));

const publicKey =
  process.env.VAPID_PUBLIC_KEY ||
  "BOIrktuQCHHiOWcKICA7YEwdKJf8WNYCmBS_PI338wnaB9VqXPQfCRwTN5NLYokujXBp5pdD83av6DACG2rAYok";
const privateKey =
  process.env.VAPID_PRIVATE_KEY ||
  "oJXO_P5wuj45JaC8taPC1E3pPR8Hu1zi_kAiv5yAaNg";
const subject = process.env.VAPID_SUBJECT || "mailto:contacto@franciscojgh.com";

webpush.setVapidDetails(subject, publicKey, privateKey);

const payload = JSON.stringify({
  title: "👀 ¿CREÍSTE QUE POR CERRAR LA PESTAÑA TE SALVABAS? 🕵️‍♂️",
  body: "Recursos Humanos te vio desconectarte, cawn. Ya abrieron la vacante de reemplazo: 'Becario que sí conteste los push'. ¡Ábrele antes de que te liquiden con una pizza fría!",
  icon: "/logotipo.svg",
  badge: "/logotipo.svg",
  url: "/notifications",
  tag: "jobnet-funny-notification-2",
  data: {
    url: "/notifications",
  },
});

console.log("Enviando notificación Web Push al endpoint...");
webpush
  .sendNotification(subscription, payload)
  .then((res) => {
    console.log("¡NOTIFICACIÓN ENVIADA CON ÉXITO! Código de estado:", res.statusCode);
  })
  .catch((err) => {
    console.error("Error al enviar la notificación:", err);
  });
