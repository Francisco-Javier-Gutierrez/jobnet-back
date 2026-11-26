import { describe, it, expect, vi } from "vitest";
import { buildJobNetHtmlEmail, buildJobNetTextEmail, sendStyledJobNetEmail } from "./emailTemplate";

const mockSend = vi.fn().mockResolvedValue({ MessageId: "msg-12345" });

vi.mock("../handlers/applications/common", () => ({
  sesClient: {
    send: (cmd: any) => mockSend(cmd),
  },
}));

describe("JobNet Email Templates Engine", () => {
  it("buildJobNetHtmlEmail generates valid, rich HTML with brand elements", () => {
    const html = buildJobNetHtmlEmail({
      title: "Nueva postulación recibida",
      badgeText: "Postulación",
      badgeType: "success",
      recipientName: "Tech Corp",
      paragraphs: [
        "Un nuevo candidato se ha postulado a tu vacante.",
        "Revisa su CV en la plataforma.",
      ],
      details: [
        { label: "Puesto", value: "Senior Frontend Engineer" },
        { label: "Modalidad", value: "Remoto" },
      ],
      highlightBox: {
        title: "Nota del candidato",
        text: "Tengo más de 5 años de experiencia en Vue y Nuxt.",
        type: "info",
      },
      cta: {
        text: "Ver Candidato",
        url: "https://dsty3j5u0b31g.cloudfront.net/applicants?jobId=123",
      },
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("JobNet");
    expect(html).toContain("logotipo.png");
    expect(html).toContain("Nueva postulación recibida");
    expect(html).toContain("Tech Corp");
    expect(html).toContain("Senior Frontend Engineer");
    expect(html).toContain("Ver Candidato");
    expect(html).toContain("https://dsty3j5u0b31g.cloudfront.net/applicants?jobId=123");
  });

  it("buildJobNetTextEmail generates clean plaintext fallback", () => {
    const text = buildJobNetTextEmail({
      title: "Actualización de Postulación",
      recipientName: "Juan Pérez",
      paragraphs: ["Tu postulación ha avanzado a la etapa de contacto."],
      cta: {
        text: "Abrir Chat",
        url: "https://dsty3j5u0b31g.cloudfront.net/messages",
      },
    });

    expect(text).toContain("JOBNET - Plataforma Profesional de Empleo");
    expect(text).toContain("Juan Pérez");
    expect(text).toContain("Tu postulación ha avanzado");
    expect(text).toContain("https://dsty3j5u0b31g.cloudfront.net/messages");
  });

  it("sendStyledJobNetEmail dispatches multipart HTML and Text via SES", async () => {
    mockSend.mockClear();
    await sendStyledJobNetEmail({
      to: "test@example.com",
      subject: "Aviso de prueba",
      templateOptions: {
        title: "Prueba de sistema",
        paragraphs: ["Contenido de prueba"],
      },
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sentCommand = mockSend.mock.calls[0][0];
    const input = sentCommand.input || sentCommand.params || sentCommand;
    expect(input.Destination.ToAddresses).toEqual(["test@example.com"]);
    expect(input.Message.Body.Html.Data).toContain("JobNet");
    expect(input.Message.Body.Text.Data).toContain("JOBNET");
  });
});
