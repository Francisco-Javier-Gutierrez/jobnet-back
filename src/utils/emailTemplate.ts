import { sesClient } from "../handlers/applications/common";
import { SendEmailCommand } from "@aws-sdk/client-ses";

export interface EmailDetailItem {
  label: string;
  value: string;
}

export interface EmailHighlightBox {
  title?: string;
  text: string;
  type?: "info" | "success" | "warning" | "danger";
}

export interface JobNetEmailOptions {
  title: string;
  preheader?: string;
  badgeText?: string;
  badgeType?: "success" | "info" | "warning" | "danger" | "purple" | "gold";
  recipientName?: string;
  paragraphs: string[];
  details?: EmailDetailItem[];
  highlightBox?: EmailHighlightBox;
  cta?: {
    text: string;
    url: string;
  };
  secondaryNotice?: string;
}

const BADGE_STYLES: Record<string, { bg: string; text: string; dot: string; border: string }> = {
  success: {
    bg: "#ecfdf5",
    text: "#047857",
    dot: "#10b981",
    border: "#a7f3d0",
  },
  info: {
    bg: "#eff6ff",
    text: "#1d4ed8",
    dot: "#2563eb",
    border: "#bfdbfe",
  },
  warning: {
    bg: "#fffbeb",
    text: "#b45309",
    dot: "#f59e0b",
    border: "#fde68a",
  },
  danger: {
    bg: "#fef2f2",
    text: "#b91c1c",
    dot: "#ef4444",
    border: "#fecaca",
  },
  purple: {
    bg: "#faf5ff",
    text: "#6d28d9",
    dot: "#8b5cf6",
    border: "#ddd6fe",
  },
  gold: {
    bg: "#fefce8",
    text: "#a16207",
    dot: "#eab308",
    border: "#fef08a",
  },
};

/**
 * Genera el template HTML de alto impacto visual con diseño JobNet en TEMA BLANCO elegante
 */
export function buildJobNetHtmlEmail(options: JobNetEmailOptions): string {
  const {
    title,
    preheader = "",
    badgeText = "Notificación Oficial",
    badgeType = "info",
    recipientName,
    paragraphs,
    details = [],
    highlightBox,
    cta,
    secondaryNotice,
  } = options;

  const badgeStyle = BADGE_STYLES[badgeType] || BADGE_STYLES.info;

  // Render paragraphs en tema blanco
  const renderedParagraphs = paragraphs
    .map(
      (p) =>
        `<p class="jobnet-text-body" style="margin: 0 0 16px 0; color: #334155; font-size: 15px; line-height: 1.65; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">${p}</p>`,
    )
    .join("");

  // Render details card if present
  let renderedDetails = "";
  if (details && details.length > 0) {
    const rows = details
      .map(
        (item) => `
        <tr>
          <td style="padding: 11px 16px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; width: 38%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">${item.label}</td>
          <td style="padding: 11px 16px; border-bottom: 1px solid #e2e8f0; color: #0f172a; font-size: 14px; font-weight: 600; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">${item.value}</td>
        </tr>`,
      )
      .join("");

    renderedDetails = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="jobnet-details-table" style="margin: 20px 0; background-color: #f8fafc; background-image: linear-gradient(#f8fafc, #f8fafc); border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; border-collapse: separate;">
        ${rows}
      </table>
    `;
  }

  // Render highlight callout box if present
  let renderedHighlight = "";
  if (highlightBox) {
    const hlStyle = BADGE_STYLES[highlightBox.type || badgeType] || badgeStyle;
    renderedHighlight = `
      <div style="margin: 20px 0; padding: 16px 18px; background-color: ${hlStyle.bg}; background-image: linear-gradient(${hlStyle.bg}, ${hlStyle.bg}); border-left: 4px solid ${hlStyle.dot}; border-top: 1px solid ${hlStyle.border}; border-right: 1px solid ${hlStyle.border}; border-bottom: 1px solid ${hlStyle.border}; border-radius: 8px;">
        ${highlightBox.title ? `<div style="font-weight: 700; font-size: 12px; color: ${hlStyle.text}; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">${highlightBox.title}</div>` : ""}
        <div style="color: #1e293b; font-size: 14px; line-height: 1.6; font-style: italic; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">${highlightBox.text}</div>
      </div>
    `;
  }

  // Render CTA button
  let renderedCta = "";
  if (cta && cta.text && cta.url) {
    renderedCta = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 28px 0 16px 0;">
        <tr>
          <td align="center">
            <a href="${cta.url}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 14px 36px; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 50%, #059669 100%); color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 700; border-radius: 12px; box-shadow: 0 8px 20px rgba(37, 99, 235, 0.28); text-align: center; letter-spacing: 0.3px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
              ${cta.text} &rarr;
            </a>
          </td>
        </tr>
      </table>
    `;
  }

  const appBaseUrl = "https://dsty3j5u0b31g.cloudfront.net";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      supported-color-schemes: light;
    }
    /* Anti-inversion Gmail: conserva el tema blanco incluso si Gmail está en modo oscuro */
    .jobnet-canvas {
      background-color: #f1f5f9 !important;
      background-image: linear-gradient(#f1f5f9, #f1f5f9) !important;
    }
    .jobnet-card {
      background-color: #ffffff !important;
      background-image: linear-gradient(#ffffff, #ffffff) !important;
    }
    .jobnet-header {
      background-color: #ffffff !important;
      background-image: linear-gradient(#ffffff, #ffffff) !important;
    }
    .jobnet-footer {
      background-color: #f8fafc !important;
      background-image: linear-gradient(#f8fafc, #f8fafc) !important;
    }
    .jobnet-details-table {
      background-color: #f8fafc !important;
      background-image: linear-gradient(#f8fafc, #f8fafc) !important;
    }
    .jobnet-text-title {
      color: #0f172a !important;
    }
    .jobnet-text-body {
      color: #334155 !important;
    }
    @media (prefers-color-scheme: dark) {
      .jobnet-canvas { background-color: #f1f5f9 !important; background-image: linear-gradient(#f1f5f9, #f1f5f9) !important; }
      .jobnet-card { background-color: #ffffff !important; background-image: linear-gradient(#ffffff, #ffffff) !important; }
      .jobnet-header { background-color: #ffffff !important; background-image: linear-gradient(#ffffff, #ffffff) !important; }
      .jobnet-text-title { color: #0f172a !important; }
      .jobnet-text-body { color: #334155 !important; }
    }
    /* Outlook / Web overrides */
    [data-ogsc] .jobnet-canvas { background-color: #f1f5f9 !important; }
    [data-ogsc] .jobnet-card { background-color: #ffffff !important; }
    [data-ogsc] .jobnet-text-title { color: #0f172a !important; }
    [data-ogsc] .jobnet-text-body { color: #334155 !important; }
    [data-ogsb] .jobnet-card { background-color: #ffffff !important; }
  </style>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
</head>
<body class="jobnet-canvas" style="margin: 0; padding: 0; background-color: #f1f5f9; background-image: linear-gradient(#f1f5f9, #f1f5f9); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;">
  
  <!-- Preheader Text (Hidden Preview sin caracteres Unicode extraños) -->
  <div style="display: none; font-size: 1px; color: #f1f5f9; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden; mso-hide: all;">
    ${preheader || title}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="jobnet-canvas" style="background-color: #f1f5f9; background-image: linear-gradient(#f1f5f9, #f1f5f9); min-height: 100vh; padding: 36px 12px;">
    <tr>
      <td align="center">
        <!-- Main Container Card (White Card) -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="jobnet-card" style="max-width: 580px; background-color: #ffffff; background-image: linear-gradient(#ffffff, #ffffff); border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.08), 0 8px 10px -6px rgba(15, 23, 42, 0.04);">
          
          <!-- Top Accent Gradient Line -->
          <tr>
            <td style="height: 4px; background: linear-gradient(90deg, #2563eb 0%, #38bdf8 35%, #10b981 70%, #059669 100%);"></td>
          </tr>

          <!-- Header Brand Section (Clean White) -->
          <tr>
            <td class="jobnet-header" style="padding: 28px 32px 20px 32px; background-color: #ffffff; background-image: linear-gradient(#ffffff, #ffffff); border-bottom: 1px solid #f1f5f9;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <!-- Brand Wordmark with Modern Logo Icon PNG -->
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="vertical-align: middle;">
                          <a href="${appBaseUrl}" target="_blank" style="text-decoration: none; display: inline-block;">
                            <img src="${appBaseUrl}/logotipo.png" alt="JobNet Logo" width="38" height="31" style="display: block; border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic;" />
                          </a>
                        </td>
                        <td style="padding-left: 12px; vertical-align: middle;">
                          <div style="font-size: 20px; font-weight: 800; letter-spacing: -0.5px; color: #0f172a; line-height: 1.1;">
                            Job<span style="color: #0284c7;">Net</span>
                          </div>
                          <div style="font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-top: 2px;">
                            Plataforma de Empleo
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <!-- Notification Badge Pill -->
                    <span style="display: inline-flex; align-items: center; padding: 6px 14px; background: ${badgeStyle.bg}; border: 1px solid ${badgeStyle.border}; border-radius: 9999px; font-size: 11px; font-weight: 700; color: ${badgeStyle.text}; text-transform: uppercase; letter-spacing: 0.5px;">
                      <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: ${badgeStyle.dot}; margin-right: 6px;"></span>
                      ${badgeText}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content Body (Clean White) -->
          <tr>
            <td style="padding: 32px 32px 28px 32px; background-color: #ffffff; background-image: linear-gradient(#ffffff, #ffffff);">
              
              <!-- Salutation if provided -->
              ${
                recipientName
                  ? `<div style="color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Hola, ${recipientName}</div>`
                  : `<div style="color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Aviso oficial</div>`
              }

              <!-- Heading Title -->
              <h1 class="jobnet-text-title" style="margin: 0 0 18px 0; color: #0f172a; font-size: 22px; font-weight: 800; line-height: 1.35; letter-spacing: -0.4px;">
                ${title}
              </h1>

              <!-- Paragraphs -->
              ${renderedParagraphs}

              <!-- Highlights / Callout -->
              ${renderedHighlight}

              <!-- Details Table -->
              ${renderedDetails}

              <!-- CTA Button -->
              ${renderedCta}

              <!-- Secondary Notice if provided -->
              ${
                secondaryNotice
                  ? `<p style="margin: 18px 0 0 0; color: #64748b; font-size: 12px; line-height: 1.5; text-align: center;">${secondaryNotice}</p>`
                  : ""
              }

            </td>
          </tr>

          <!-- Card Divider -->
          <tr>
            <td style="height: 1px; background-color: #f1f5f9; margin: 0; padding: 0;"></td>
          </tr>

          <!-- Footer Section (Soft Light Gray) -->
          <tr>
            <td class="jobnet-footer" style="padding: 24px 32px; background-color: #f8fafc; background-image: linear-gradient(#f8fafc, #f8fafc); text-align: center; border-top: 1px solid #e2e8f0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom: 12px;">
                    <a href="${appBaseUrl}" target="_blank" style="color: #2563eb; text-decoration: none; font-size: 12px; font-weight: 600; margin: 0 10px;">Portal Web</a>
                    <span style="color: #cbd5e1;">&bull;</span>
                    <a href="${appBaseUrl}/vacancies" target="_blank" style="color: #64748b; text-decoration: none; font-size: 12px; margin: 0 10px;">Bolsa de Trabajo</a>
                    <span style="color: #cbd5e1;">&bull;</span>
                    <a href="${appBaseUrl}/terms" target="_blank" style="color: #64748b; text-decoration: none; font-size: 12px; margin: 0 10px;">Términos</a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="color: #64748b; font-size: 11px; line-height: 1.6; padding-bottom: 8px;">
                    Este es un correo oficial generado de manera automatizada por JobNet.<br>
                    Para tu seguridad, JobNet nunca te solicitará tus contraseñas por correo electrónico.
                  </td>
                </tr>
                <tr>
                  <td align="center" style="color: #94a3b8; font-size: 11px; font-weight: 500;">
                    &copy; 2026 JobNet. Todos los derechos reservados.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

/**
 * Genera el fallback de texto plano legible para clientes sin soporte HTML
 */
export function buildJobNetTextEmail(options: JobNetEmailOptions): string {
  const { title, recipientName, paragraphs, details = [], highlightBox, cta } = options;

  let text = `========================================\n`;
  text += ` JOBNET - Plataforma Profesional de Empleo\n`;
  text += `========================================\n\n`;

  if (recipientName) {
    text += `Hola, ${recipientName}:\n\n`;
  }

  text += `${title}\n\n`;

  for (const p of paragraphs) {
    text += `${p}\n\n`;
  }

  if (highlightBox) {
    text += `----------------------------------------\n`;
    if (highlightBox.title) text += `[${highlightBox.title}]\n`;
    text += `${highlightBox.text}\n`;
    text += `----------------------------------------\n\n`;
  }

  if (details && details.length > 0) {
    text += `DETALLES:\n`;
    for (const item of details) {
      text += `  * ${item.label}: ${item.value}\n`;
    }
    text += `\n`;
  }

  if (cta) {
    text += `>> Acceder: ${cta.text}\n`;
    text += `   ${cta.url}\n\n`;
  }

  text += `----------------------------------------\n`;
  text += `(c) 2026 JobNet. Todos los derechos reservados.\n`;
  text += `https://dsty3j5u0b31g.cloudfront.net\n`;

  return text;
}

/**
 * Función centralizada para despachar correos elegantes vía Amazon SES
 */
export async function sendStyledJobNetEmail({
  to,
  subject,
  templateOptions,
  source = "noreply@franciscojgh.com",
  client = sesClient,
}: {
  to: string;
  subject: string;
  templateOptions: JobNetEmailOptions;
  source?: string;
  client?: any;
}) {
  const htmlBody = buildJobNetHtmlEmail(templateOptions);
  const textBody = buildJobNetTextEmail(templateOptions);

  return client.send(
    new SendEmailCommand({
      Source: source,
      Destination: {
        ToAddresses: [to],
      },
      Message: {
        Subject: {
          Data: subject,
          Charset: "UTF-8",
        },
        Body: {
          Html: {
            Data: htmlBody,
            Charset: "UTF-8",
          },
          Text: {
            Data: textBody,
            Charset: "UTF-8",
          },
        },
      },
    }),
  );
}
