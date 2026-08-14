/**
 * Minimal AWS SigV4 request signer.
 *
 * The AWS SDK is deliberately not used. It would add megabytes to the bundle and
 * pulls in Node built-ins that do not exist on Obsidian mobile. Everything here
 * runs on Web Crypto, which is available on desktop and mobile alike.
 *
 * Only what Bedrock's Converse API needs is implemented: a signed POST with a
 * JSON body, no chunked encoding, no pre-signed URLs.
 */

/** Credentials for signing. The session token is only set for temporary keys. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const ENCODER = new TextEncoder();

/** SHA-256 of a string, lowercase hex. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', ENCODER.encode(input));
  return toHex(digest);
}

/** HMAC-SHA256, returning raw bytes so keys can be chained. */
async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, ENCODER.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Derives the scoped signing key. AWS chains four HMACs so that a leaked signing
 * key is only usable for one date, region and service.
 */
async function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(ENCODER.encode(`AWS4${secretAccessKey}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Percent-encodes a path segment the way AWS expects, which is stricter than
 * `encodeURIComponent`: these four characters are left alone by the built-in but
 * must be escaped for the signature to match.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Builds the canonical path.
 *
 * Every AWS service except S3 expects the path encoded *twice*. `URL.pathname`
 * has already encoded it once, so each segment is encoded again here. A colon in
 * a Bedrock model ID therefore appears as `%253A` in the string to sign while the
 * request itself still sends `%3A`. Getting this wrong yields a 403 whose message
 * blames the secret key.
 *
 * @param pathname Already-encoded path from `URL`.
 * @returns The doubly-encoded canonical path.
 */
function canonicalPath(pathname: string): string {
  return pathname.split('/').map(encodeSegment).join('/');
}

/** Result of signing: headers to attach verbatim to the request. */
export interface SignedHeaders {
  [name: string]: string;
}

/**
 * Signs a POST request and returns the headers to send.
 *
 * @param params.url Full request URL.
 * @param params.body Exact request body that will be sent.
 * @param params.region AWS region, must match the endpoint host.
 * @param params.service Service name, `bedrock` for Bedrock runtime.
 * @param params.credentials Access key, secret, and session token when temporary.
 * @returns Headers including Authorization.
 */
export async function signPost(params: {
  url: string;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
}): Promise<SignedHeaders> {
  const { url, body, region, service, credentials } = params;
  const target = new URL(url);

  // SigV4 timestamps must be basic-format UTC: 20260804T101530Z.
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const shortDate = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(body);

  // Canonical headers must be lowercase, sorted, and exactly the set listed in
  // SignedHeaders. Any mismatch produces an opaque 403.
  const headers: SignedHeaders = {
    host: target.host,
    'content-type': 'application/json',
    'x-amz-date': amzDate,
  };
  if (credentials.sessionToken) {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    'POST',
    canonicalPath(target.pathname),
    target.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${shortDate}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const key = await signingKey(credentials.secretAccessKey, shortDate, region, service);
  const signature = toHex(await hmac(key, stringToSign));

  return {
    ...headers,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
