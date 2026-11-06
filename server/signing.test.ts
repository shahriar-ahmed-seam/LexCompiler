import crypto from 'node:crypto';
import * as pkijs from 'pkijs';
import { describe, expect, it } from 'vitest';
import { awsKmsSigner, gcpKmsSigner, registerTrustedKey, revoke, verifyAttestationSignature, type KmsClientLike } from './enterprise/attestationSigner.js';
import { verifyEd25519CertificateSignature } from './enterprise/enterpriseSuite.js';
import { buildTimestampRequest, requestTimestamp, verifyTimestamp } from './enterprise/timestamp.js';
import { fakeTsa } from './testing/fakeTsa.js';

describe('KMS-backed attestation signers', () => {
  it('Google Cloud KMS: signs through :asymmetricSign (Ed25519 and P-256)', async () => {
    for (const [alg, type] of [['EC_SIGN_ED25519', 'ed25519'], ['EC_SIGN_P256_SHA256', 'ec']] as const) {
      const pair = type === 'ed25519' ? crypto.generateKeyPairSync('ed25519') : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
      const signing = Buffer.from('{"verdict":"SAT"}');
      const fakeKms = (async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, body });
        if (url.endsWith('/publicKey')) return new Response(JSON.stringify({ pem: pair.publicKey.export({ type: 'spki', format: 'pem' }), algorithm: alg, protectionLevel: 'HSM' }));
        // KMS signs the raw data (Ed25519) or the supplied SHA-256 digest (ECDSA). Node cannot sign a
        // pre-hashed digest, so the fake checks the digest and signs the data it was computed from.
        if (type !== 'ed25519') expect(body.digest.sha256).toBe(crypto.createHash('sha256').update(signing).digest('base64'));
        const sig = type === 'ed25519' ? crypto.sign(null, Buffer.from(body.data, 'base64'), pair.privateKey) : crypto.sign('sha256', signing, { key: pair.privateKey, dsaEncoding: 'der' });
        return new Response(JSON.stringify({ signature: sig.toString('base64') }));
      }) as typeof fetch;
      process.env.LEXCOMPILER_GCP_ACCESS_TOKEN = 'test-token';
      const signer = await gcpKmsSigner('projects/p/locations/eu/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1', fakeKms);
      expect(signer.backend).toContain('(HSM)');
      const data = signing;
      const sig = await signer.sign(data);
      expect(verifyAttestationSignature(signer.algorithm, signer.publicKeyPem, data, sig)).toBe(true);
      expect(verifyAttestationSignature(signer.algorithm, signer.publicKeyPem, Buffer.from('tampered'), sig)).toBe(false);
      expect(calls.at(-1)!.url).toMatch(/cryptoKeyVersions\/1:asymmetricSign$/);
    }
  });

  it('AWS KMS: signs with ECDSA_SHA_256 and never sees a private key', async () => {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const client: KmsClientLike = {
      async send(cmd: unknown) {
        const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
        if (c.constructor.name === 'GetPublicKeyCommand') return { KeySpec: 'ECC_NIST_P256', KeyId: 'arn:aws:kms:eu-central-1:1:key/abc', PublicKey: pair.publicKey.export({ type: 'spki', format: 'der' }) };
        expect(c.input).toMatchObject({ MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' });
        return { Signature: crypto.sign('sha256', Buffer.from(c.input.Message as Uint8Array), { key: pair.privateKey, dsaEncoding: 'der' }) };
      },
    };
    const signer = await awsKmsSigner('alias/lexcompiler', client);
    const data = Buffer.from('payload');
    expect(verifyAttestationSignature('ECDSA_P256_SHA256', signer.publicKeyPem, data, await signer.sign(data))).toBe(true);
  });

  it('keeps rotated keys trusted and honours revocation', async () => {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const client: KmsClientLike = {
      async send(cmd: unknown) {
        const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
        if (c.constructor.name === 'GetPublicKeyCommand') return { KeySpec: 'ECC_NIST_P256', PublicKey: pair.publicKey.export({ type: 'spki', format: 'der' }) };
        return { Signature: crypto.sign('sha256', Buffer.from(c.input.Message as Uint8Array), { key: pair.privateKey, dsaEncoding: 'der' }) };
      },
    };
    const rotated = await awsKmsSigner('old-key', client);
    registerTrustedKey(rotated);
    const payload = '{"overallVerdict":"SAT_COMPLIANT_ATTESTED","n":1}';
    const sig = (await rotated.sign(Buffer.from(payload))).toString('hex');
    expect(verifyEd25519CertificateSignature(payload, sig, undefined, { keyId: rotated.keyId })).toMatchObject({ verified: true, keyId: rotated.keyId });
    revoke({ certificateId: 'CERT-1', reason: 'superseded' });
    expect(verifyEd25519CertificateSignature(payload, sig, undefined, { certificateId: 'CERT-1' }).reason).toMatch(/REVOKED: certificate/);
    revoke({ keyId: rotated.keyId, reason: 'key compromise' });
    expect(verifyEd25519CertificateSignature(payload, sig).reason).toMatch(/REVOKED: signing key/);
  });
});

/** Fake Time-Stamp Authority: a self-signed RSA certificate that signs TSTInfo in CMS. */

describe('RFC 3161 timestamps', () => {
  it('builds a SHA-256 request with a nonce', () => {
    const req = pkijs.TimeStampReq.fromBER(buildTimestampRequest(Buffer.from('x')));
    expect(req.messageImprint.hashAlgorithm.algorithmId).toBe('2.16.840.1.101.3.4.2.1');
    expect(req.certReq).toBe(true);
    expect(req.nonce).toBeDefined();
  });

  it('obtains and verifies a token, and rejects it for other data', async () => {
    const tsa = (await fakeTsa()) as unknown as typeof fetch;
    const signature = Buffer.from('attestation-signature');
    const token = await requestTimestamp(signature, 'https://tsa.test', tsa);
    expect(token.serialNumber).toBe('2a');
    expect(await verifyTimestamp(token.tokenBase64, signature)).toEqual(expect.objectContaining({ valid: true }));
    expect((await verifyTimestamp(token.tokenBase64, Buffer.from('other'))).reason).toMatch(/different data/);
    const tampered = Buffer.from(token.tokenBase64, 'base64');
    tampered[tampered.length - 5] ^= 0xff;
    expect((await verifyTimestamp(tampered.toString('base64'), signature)).valid).toBe(false);
  });
});
