/**
 * Cognito authentication for the browser.
 *
 * Uses SRP so the password is never sent to Cognito in the clear, and requires
 * no OAuth redirect flow. Because users are created by an administrator, the
 * first sign-in hits a NEW_PASSWORD_REQUIRED challenge, which is surfaced to the
 * UI so the user can choose a permanent password.
 *
 * The library persists tokens in localStorage and refreshes the access token
 * using the refresh token, so a session survives a page reload.
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from 'amazon-cognito-identity-js';

/** @type {CognitoUserPool|null} */
let pool = null;

/**
 * Initialises the user pool from server-provided configuration.
 *
 * @param {{userPoolId: string, clientId: string}} config Pool identifiers.
 */
export function initAuth(config) {
  pool = new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.clientId,
  });
}

/**
 * @returns {CognitoUser|null} The cached signed-in user, if any.
 */
export function currentUser() {
  return pool?.getCurrentUser() ?? null;
}

/**
 * Returns a valid access token, refreshing it if the cached one has expired.
 *
 * @returns {Promise<string|null>} JWT access token, or null when signed out.
 */
export function getAccessToken() {
  const user = currentUser();
  if (!user) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    // getSession refreshes automatically when the access token is stale.
    user.getSession((error, session) => {
      if (error || !session?.isValid()) {
        resolve(null);
        return;
      }
      resolve(session.getAccessToken().getJwtToken());
    });
  });
}

/**
 * Signs in with username and password.
 *
 * Resolves with `{ status: 'success' }`, or `{ status: 'newPasswordRequired' }`
 * when the administrator-issued temporary password must be replaced. In the
 * latter case call `completeNewPassword` with the same username.
 *
 * @param {string} username Cognito username.
 * @param {string} password Password.
 * @returns {Promise<{status: 'success'|'newPasswordRequired'}>} Outcome.
 */
export function signIn(username, password) {
  if (!pool) {
    return Promise.reject(new Error('Auth not initialised'));
  }

  const user = new CognitoUser({ Username: username, Pool: pool });
  const details = new AuthenticationDetails({ Username: username, Password: password });

  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: () => resolve({ status: 'success' }),
      onFailure: (error) => reject(new Error(friendlyAuthError(error))),
      newPasswordRequired: () => {
        // Hold the challenged user object so completeNewPassword can continue
        // the same authentication session.
        pendingUser = user;
        resolve({ status: 'newPasswordRequired' });
      },
    });
  });
}

/** @type {CognitoUser|null} User mid-way through the new-password challenge. */
let pendingUser = null;

/**
 * Completes the forced password change on first sign-in.
 *
 * @param {string} newPassword The permanent password.
 * @returns {Promise<{status: 'success'}>} Outcome.
 */
export function completeNewPassword(newPassword) {
  if (!pendingUser) {
    return Promise.reject(new Error('No password change in progress. Sign in again.'));
  }

  return new Promise((resolve, reject) => {
    pendingUser.completeNewPasswordChallenge(newPassword, {}, {
      onSuccess: () => {
        pendingUser = null;
        resolve({ status: 'success' });
      },
      onFailure: (error) => reject(new Error(friendlyAuthError(error))),
    });
  });
}

/** Signs the current user out and clears cached tokens. */
export function signOut() {
  currentUser()?.signOut();
  pendingUser = null;
}

/**
 * Converts a Cognito error into something worth showing a user, without
 * revealing whether an account exists.
 *
 * @param {{code?: string, message?: string}} error Cognito error.
 * @returns {string} Display message.
 */
function friendlyAuthError(error) {
  switch (error?.code) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return 'Incorrect username or password.';
    case 'PasswordResetRequiredException':
      return 'Your password needs resetting. Ask the administrator.';
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return 'Too many attempts. Wait a moment and try again.';
    case 'InvalidPasswordException':
      return error.message || 'That password does not meet the policy.';
    default:
      return error?.message || 'Sign-in failed.';
  }
}
