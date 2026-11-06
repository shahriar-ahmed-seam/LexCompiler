import crypto from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

const toAB = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** A Time-Stamp Authority for tests: answers RFC 3161 requests with a token signed by a self-signed certificate. */
export async function fakeTsa() {
  const subtle = crypto.webcrypto.subtle;
  const keys = (await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: 1 });
  const cn = new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'Test TSA' }) });
  cert.issuer.typesAndValues.push(cn);
  cert.subject.typesAndValues.push(cn);
  cert.notBefore.value = new Date(Date.now() - 60_000);
  cert.notAfter.value = new Date(Date.now() + 86_400_000);
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, 'SHA-256');
  return async (url: string, init?: RequestInit) => {
    const body = init!.body as Buffer;
    const req = pkijs.TimeStampReq.fromBER(toAB(Buffer.from(body)));
    const tst = new pkijs.TSTInfo({
      version: 1,
      policy: '1.2.3.4.1',
      messageImprint: req.messageImprint,
      serialNumber: new asn1js.Integer({ value: 42 }),
      genTime: new Date(),
      nonce: req.nonce,
    });
    const content = tst.toSchema().toBER(false);
    const signed = new pkijs.SignedData({
      version: 3,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.9.16.1.4', eContent: new asn1js.OctetString({ valueHex: content }) }),
      signerInfos: [
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
          // CMS requires signed attributes when the content is not id-data.
          signedAttrs: new pkijs.SignedAndUnsignedAttributes({
            type: 0,
            attributes: [
              new pkijs.Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.9.16.1.4' })] }),
              new pkijs.Attribute({ type: '1.2.840.113549.1.9.4', values: [new asn1js.OctetString({ valueHex: toAB(crypto.createHash('sha256').update(Buffer.from(content)).digest()) })] }),
            ],
          }),
        }),
      ],
      certificates: [cert],
    });
    await signed.sign(keys.privateKey, 0, 'SHA-256');
    const resp = new pkijs.TimeStampResp({
      status: new pkijs.PKIStatusInfo({ status: 0 }),
      timeStampToken: new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: signed.toSchema(true) }),
    });
    void url;
    return new Response(Buffer.from(resp.toSchema().toBER(false)));
  };
}
