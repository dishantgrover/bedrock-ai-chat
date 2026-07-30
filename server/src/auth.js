/**
 * Cognito access-token verification.
 *
 * The browser only ever holds a Cognito JWT; AWS credentials stay on the server.
 * Every API request is verified against the user pool's public keys, which
 * `aws-jwt-verify` fetches and caches.
 */
import { CognitoJwtVerifier } from 'aws-jwt-verify';

import { COGNITO_CLIENT_ID, COGNITO_USER_POOL_ID } from './config.js';

const verifier = CognitoJwtVerifier.create({
  userPoolId: COGNITO_USER_POOL_ID,
  tokenUse: 'access',
  clientId: COGNITO_CLIENT_ID,
});

/**
 * Express middleware that verifies the bearer token and attaches the caller.
 *
 * On success sets `req.user` to `{ id, username }`, where `id` is the Cognito
 * `sub`. The `sub` is used as the partition key for the user's data because it
 * is immutable, unlike a username.
 *
 * @param {import('express').Request} req Request.
 * @param {import('express').Response} res Response.
 * @param {import('express').NextFunction} next Next handler.
 */
export async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  try {
    const payload = await verifier.verify(token);
    req.user = {
      id: payload.sub,
      username: payload.username || payload['cognito:username'] || payload.sub,
    };
    next();
  } catch {
    // Deliberately opaque: do not tell a caller why a token was rejected.
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
