// El correo sale a nombre del negocio que lo manda y la respuesta le llega a ese negocio, no a Cubivo
import { jest } from "@jest/globals"
import { sendEmail } from "./email.ts"

describe("sendEmail", () => {
  let sent: Record<string, unknown>[] = []
  beforeEach(() => {
    sent = []
    process.env.RESEND_API_KEY = "re_prueba"
    process.env.EMAIL_FROM = "Cubivo <facturas@cubivo.org>"
    delete process.env.EMAIL_TEST_TO
    jest.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response("{}", { status: 200 })
    })
  })
  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env.RESEND_API_KEY
    delete process.env.EMAIL_FROM
  })

  it("usa el nombre del negocio y su correo para las respuestas", async () => {
    await sendEmail({ to: "cliente@x.cr", subject: "s", html: "h", senderName: "Ferretería \"El <Clavo>\"\r\nBcc: x", replyTo: " ventas@clavo.cr " })
    expect(sent[0]).toMatchObject({ from: '"Ferretería El Clavo Bcc: x vía Cubivo" <facturas@cubivo.org>', reply_to: "ventas@clavo.cr" })
  })

  it("sin nombre ni correo válido queda el remitente de Cubivo y sin reply_to", async () => {
    await sendEmail({ to: "cliente@x.cr", subject: "s", html: "h", senderName: "  ", replyTo: "no-es-correo" })
    expect(sent[0]!.from).toBe("Cubivo <facturas@cubivo.org>")
    expect(sent[0]).not.toHaveProperty("reply_to")
  })
})
