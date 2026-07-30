/**
 * Rejects requests that did not arrive through the expected CloudFront
 * distribution.
 *
 * The instance security group only admits the AWS-managed CloudFront
 * origin-facing prefix list, but that list covers every CloudFront distribution
 * in existence, not just ours. Validating a secret header that only our
 * distribution attaches closes that gap.
 *
 * Disabled when `ORIGIN_SECRET` is unset so local development still works.
 */
import { timingSafeEqual } from 'node:crypto';

import { ORIGIN_SECRET, ORIGIN_SECRET_HEADER } from './config.js';

const expected = Buffer.from(ORIGIN_SECRET, 'utf8');

/**
 * Compares two strings without leaking their relationship through timing.
 *
 * @param {string} candidate Value supplied by the caller.
 * @returns {boolean} True when the value matches the configured secret.
 */
function matchesSecret(candidate) {
  const supplied = Buffer.from(candidate, 'utf8');
  // timingSafeEqual throws on length mismatch, so length is checked first. The
  // length of the expected secret is not sensitive.
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Express middleware enforcing the origin secret.
 *
 * @param {import('express').Request} req Request.
 * @param {import('express').Response} res Response.
 * @param {import('express').NextFunction} next Next handler.
 */
export function requireOriginSecret(req, res, next) {
  if (!ORIGIN_SECRET) {
    next();
    return;
  }

  const supplied = req.get(ORIGIN_SECRET_HEADER);
  if (typeof supplied === 'string' && matchesSecret(supplied)) {
    next();
    return;
  }

  // 403 with no detail: a direct caller learns nothing about what is missing.
  res.status(403).send('Forbidden');
}
