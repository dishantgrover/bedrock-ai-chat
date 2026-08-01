/**
 * Checks that a turn which fails upstream leaves no trace in storage.
 *
 * A failed turn used to persist the question with no answer, so every retry
 * stored another copy and those copies were replayed to the model on later
 * turns. This asserts the opposite: after a failure the conversation must have
 * exactly zero messages, and the `done`/`error` frame must report
 * `persisted: false` so the client can roll its optimistic message back.
 *
 * Needs a model that actually fails. The practical way to arrange that is to
 * point MANTLE_REGION at a Region where Grok is unhealthy, restart the service,
 * run this, then restore.
 *
 * Usage: node scripts/verify-failed-turn.js <baseUrl> <user> <pass> [modelId]
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from 'amazon-cognito-identity-js';

const [baseUrl, username, password, modelId = 'grok-4-3'] = process.argv.slice(2);

if (!baseUrl || !username || !password) {
  console.error('Usage: verify-failed-turn.js <baseUrl> <user> <pass> [modelId]');
  process.exit(64);
}

const config = await (await fetch(`${baseUrl}/api/config`)).json();
const pool = new CognitoUserPool({
  UserPoolId: config.userPoolId,
  ClientId: config.clientId,
});

const accessToken = await new Promise((resolve, reject) => {
  new CognitoUser({ Username: username, Pool: pool }).authenticateUser(
    new AuthenticationDetails({ Username: username, Password: password }),
    {
      onSuccess: (session) => resolve(session.getAccessToken().getJwtToken()),
      onFailure: reject,
      newPasswordRequired: () => reject(new Error('User must set a permanent password first')),
    },
  );
});

/** Authenticated JSON helper. */
async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

const { conversation } = await api('/api/conversations', {
  method: 'POST',
  body: JSON.stringify({ modelId }),
});
console.log(`conversation: ${conversation.id} model=${conversation.modelId}`);

const streamResponse = await fetch(`${baseUrl}/api/chat/${conversation.id}/messages`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({ content: 'This turn is expected to fail.' }),
});

const raw = await streamResponse.text();
const errorFrame = raw.match(/^event: error\ndata: (.+)$/m);
const doneFrame = raw.match(/^event: done\ndata: (.+)$/m);
const deltas = [...raw.matchAll(/^event: delta\ndata: (.+)$/gm)].length;

const frame = errorFrame ?? doneFrame;
const payload = frame ? JSON.parse(frame[1]) : null;

console.log(`frames: deltas=${deltas} error=${Boolean(errorFrame)} done=${Boolean(doneFrame)}`);
console.log(`payload: ${JSON.stringify(payload)}`);

const reloaded = await api(`/api/conversations/${conversation.id}`);
console.log(`persisted messages: ${reloaded.messages.length}`);

await api(`/api/conversations/${conversation.id}`, { method: 'DELETE' });

if (deltas > 0) {
  console.log('SKIP: the model succeeded, so the failure path was not exercised');
  process.exit(2);
}

const ok = reloaded.messages.length === 0 && payload?.persisted === false;
console.log(
  ok
    ? 'RESULT: PASS (failure left no messages, client told persisted=false)'
    : `RESULT: FAIL (expected 0 messages and persisted=false, got ${reloaded.messages.length} and ${payload?.persisted})`,
);
process.exit(ok ? 0 : 1);
