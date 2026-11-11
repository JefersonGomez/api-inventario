// Firma XAdES-EPES (Anexo 2 de Hacienda): firma envuelta RSA-SHA256 sobre todo el comprobante, con la
// política de Hacienda, el certificado en KeyInfo y la hora de firma. La llave .p12 se lee con
// node-forge (Node no extrae la llave privada de un PKCS#12) y se firma con WebCrypto.
// Nunca se registra ni se devuelve la llave ni su PIN.
import { createPrivateKey, webcrypto } from "node:crypto"
import { DOMParser, XMLSerializer } from "@xmldom/xmldom"
import forge from "node-forge"
import * as xadesjs from "xadesjs"
import * as xmldsigjs from "xmldsigjs"
import xpath from "xpath"
import { XADES_POLICY } from "./codes.ts"

let ready = false
function init() {
  if (ready) return
  xadesjs.setNodeDependencies({ DOMParser, XMLSerializer, xpath })
  xadesjs.Application.setEngine("NodeJS", webcrypto as unknown as Crypto)
  xmldsigjs.Application.setEngine("NodeJS", webcrypto as unknown as Crypto)
  ready = true
}

export type SigningKey = {
  privateKey: CryptoKey
  certificate: string // DER en base64
  holderId: string // identificación del titular (solo dígitos, sin ceros a la izquierda)
  holderName: string
  notAfter: Date
}

// Lee la llave .p12; un PIN equivocado da un error claro (sin detalles internos)
export async function loadSigningKey(p12: Buffer, pin: string): Promise<SigningKey> {
  let parsed: forge.pkcs12.Pkcs12Pfx
  try {
    parsed = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.binary.raw.encode(new Uint8Array(p12))), pin)
  } catch {
    throw new Error("No se pudo abrir la llave criptográfica: revisa el PIN")
  }
  const keyBag = parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag! })[forge.pki.oids.pkcs8ShroudedKeyBag!]?.[0]
  const certBag = parsed.getBags({ bagType: forge.pki.oids.certBag! })[forge.pki.oids.certBag!]?.[0]
  if (!keyBag?.key || !certBag?.cert) throw new Error("La llave criptográfica no trae la llave privada o el certificado")
  const pkcs8 = createPrivateKey(forge.pki.privateKeyToPem(keyBag.key)).export({ type: "pkcs8", format: "der" })
  const privateKey = await webcrypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
  const cert = certBag.cert
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  const serial = String(cert.subject.getField({ name: "serialNumber" })?.value ?? cert.subject.getField("serialNumber")?.value ?? "")
  return {
    privateKey: privateKey as unknown as CryptoKey,
    certificate: forge.util.encode64(der),
    holderId: serial.replace(/\D/g, "").replace(/^0+/, ""),
    holderName: String(cert.subject.getField("CN")?.value ?? ""),
    notAfter: cert.validity.notAfter,
  }
}

// Firma el XML y devuelve el documento firmado
export async function signXml(xml: string, key: SigningKey, signingTime = new Date()) {
  init()
  const doc = xadesjs.Parse(xml)
  const signed = new xadesjs.SignedXml()
  const signature = await signed.Sign(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as Algorithm,
    key.privateKey,
    doc,
    {
      references: [{ hash: "SHA-256", uri: "", transforms: ["enveloped", "c14n"] }],
      policy: { hash: "SHA-256", digestValue: XADES_POLICY.digest, identifier: { value: XADES_POLICY.uri } },
      signingCertificate: key.certificate,
      signingTime: { value: signingTime },
      x509: [key.certificate],
    } as unknown as xadesjs.OptionsXAdES,
  )
  doc.documentElement.appendChild(signature.GetXml()!)
  return new XMLSerializer().serializeToString(doc as unknown as Parameters<XMLSerializer["serializeToString"]>[0])
}

// Verifica la firma de un XML firmado (para las pruebas y para revisar lo guardado)
export async function verifyXml(signedXml: string) {
  init()
  const doc = xadesjs.Parse(signedXml)
  const node = doc.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "Signature")[0]
  if (!node) return false
  const signed = new xadesjs.SignedXml(doc)
  signed.LoadXml(node)
  // un documento alterado hace fallar el digest: eso es "no verifica", no un error
  return signed.Verify().catch(() => false)
}
