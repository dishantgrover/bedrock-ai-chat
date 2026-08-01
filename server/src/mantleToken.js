/**
 * Generates short-lived bearer tokens for the Amazon Bedrock `bedrock-mantle`
 * endpoint, which authenticates with an OpenAI-style `Authorization: Bearer`
 * header rather than SigV4 request signing.
 *
 * The token is a SigV4 *presigned* URL for `bedrock:CallWithBearerToken`,
 * base64-encoded and prefixed. This mirrors the reference implementation in the
 * `aws-bedrock-token-generator` Python package so the wire format stays
 * identical.
 *
 * Tokens are cached in memory and refreshed before expiry, so a warm server
 * signs roughly twice a day instead of once per request.
 */
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

const HOST = 'bedrock.amazonaws.com';
const SERVICE = 'bedrock';
const AUTH_PREFIX = 'bedrock-api-key-';
const TOKEN_VERSION = '&Version=1';

/** Maximum token lifetime accepted by Bedrock: 12 hours. */
const MAX_TOKEN_SECONDS = 43200;

/**
 * Refresh this long before actual expiry so an in-flight request never races
 * the boundary.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Floor for a token's usable lifetime. If the signing credentials are closer to
 * expiry than this, a fresh set is not available to us anyway, so signing goes
 * ahead and the short-lived token gets replaced on the next call.
 */
const MIN_TOKEN_SECONDS = 120;

const credentialProvider = fromNodeProviderChain();

/** @type {Map<string, { token: string, expiresAt: number }>} */
const cache = new Map();

/**
 * Builds a bearer token and reports when it actually stops working.
 *
 * A presigned URL is only valid while the credentials that signed it are valid.
 * On an instance role those are temporary and rotate every few hours, so asking
 * for a 12-hour lifetime does not grant one -- the token dies with the
 * credentials and Mantle answers `401 The security token included in the request
 * is expired`. The requested lifetime is therefore capped to the credentials'
 * own remaining life.
 *
 * @param {string} region AWS region, e.g. `us-east-1`.
 * @param {number} [expiresIn] Requested lifetime in seconds (max 43200).
 * @returns {Promise<{token: string, expiresAt: number}>} Token and its real expiry.
 */
async function signMantleToken(region, expiresIn = MAX_TOKEN_SECONDS) {
  if (!region) {
    throw new Error('generateMantleToken: region is required');
  }
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_TOKEN_SECONDS) {
    throw new Error(
      `generateMantleToken: expiresIn must be between 1 and ${MAX_TOKEN_SECONDS} seconds`,
    );
  }

  const credentials = await credentialProvider();

  // Long-lived credentials (an IAM user access key) report no expiration, in
  // which case the requested lifetime stands.
  let effectiveSeconds = expiresIn;
  if (credentials.expiration) {
    const secondsLeft = Math.floor((credentials.expiration.getTime() - Date.now()) / 1000);
    effectiveSeconds = Math.max(MIN_TOKEN_SECONDS, Math.min(expiresIn, secondsLeft - 60));
  }

  const signer = new SignatureV4({
    service: SERVICE,
    region,
    credentials,
    sha256: Sha256,
    // Bedrock expects the canonical request to be built without the extra
    // hoisting rules the SDK applies to some services.
    uriEscapePath: false,
  });

  const request = new HttpRequest({
    method: 'POST',
    protocol: 'https:',
    hostname: HOST,
    path: '/',
    query: { Action: 'CallWithBearerToken' },
    headers: { host: HOST },
  });

  const presigned = await signer.presign(request, { expiresIn: effectiveSeconds });

  // Reassemble the presigned URL exactly as botocore would render it, minus the
  // scheme, then base64-encode it.
  const query = presigned.query ?? {};
  const search = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

  const presignedUrl = `${HOST}${presigned.path}?${search}${TOKEN_VERSION}`;

  return {
    token: `${AUTH_PREFIX}${Buffer.from(presignedUrl, 'utf8').toString('base64')}`,
    expiresAt: Date.now() + effectiveSeconds * 1000,
  };
}

/**
 * Builds a bearer token for the given region.
 *
 * @param {string} region AWS region, e.g. `us-east-1`.
 * @param {number} [expiresIn] Requested lifetime in seconds (max 43200).
 * @returns {Promise<string>} Bearer token to send as `Authorization: Bearer <token>`.
 */
export async function generateMantleToken(region, expiresIn = MAX_TOKEN_SECONDS) {
  const { token } = await signMantleToken(region, expiresIn);
  return token;
}

/**
 * Returns a cached bearer token for the region, regenerating it when it is
 * missing or close to expiring.
 *
 * The cached expiry is the token's *real* expiry, which is bounded by the
 * signing credentials rather than by what was requested.
 *
 * @param {string} region AWS region.
 * @returns {Promise<string>} Bearer token.
 */
export async function getMantleToken(region) {
  const cached = cache.get(region);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  const { token, expiresAt } = await signMantleToken(region);
  cache.set(region, { token, expiresAt });
  return token;
}

/**
 * Drops the cached token for a region so the next call signs a fresh one.
 *
 * Used to recover from a 401: if the credentials rotated in a way the cached
 * expiry did not predict, discarding and re-signing fixes it immediately rather
 * than failing until the cache lapses.
 *
 * @param {string} region AWS region.
 */
export function invalidateMantleToken(region) {
  cache.delete(region);
}
