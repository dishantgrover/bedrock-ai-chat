/**
 * End-to-end check against a deployed environment.
 *
 * Signs in with SRP exactly as the browser does, then exercises the full
 * authenticated path: create a conversation, stream a reply, reload the thread
 * from storage and confirm the turns persisted.
 *
 * Usage:
 *   node scripts/verify-deployment.js https://ai.example.com USERNAME PASSWORD [modelId]
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from 'amazon-cognito-identity-js';

const [baseUrl, username, password, modelId = 'claude-sonnet-4-5'] = process.argv.slice(2);

if (!baseUrl || !username || !password) {
  console.error('Usage: verify-deployment.js <baseUrl> <username> <password> [modelId]');
  process.exit(64);
}

/** Fails the run with a message. */
function fail(message) {
  console.log(`FAIL ${message}`);
  process.exit(1);
}

const config = await (await fetch(`${baseUrl}/api/config`)).json();
console.log(`config: pool=${config.userPoolId} models=${config.models.length}`);

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
      newPasswordRequired: () =>
        reject(new Error('User must set a permanent password before this check can run')),
    },
  );
});
console.log(`auth: access token acquired (${accessToken.length} chars)`);

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

// Rejecting an unauthenticated request is the property that matters most here.
const anonymous = await fetch(`${baseUrl}/api/conversations`);
if (anonymous.status !== 401) {
  fail(`unauthenticated request returned ${anonymous.status}, expected 401`);
}
console.log('authz: unauthenticated request correctly rejected with 401');

const me = await api('/api/me');
console.log(`me: ${me.user.username} usedToday=${me.usage.outputTokensToday}`);

const { conversation } = await api('/api/conversations', {
  method: 'POST',
  body: JSON.stringify({ modelId }),
});
console.log(`conversation: ${conversation.id} model=${conversation.modelId}`);

const prompt = 'Reply with exactly: DEPLOY_OK';
const streamResponse = await fetch(`${baseUrl}/api/chat/${conversation.id}/messages`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({ content: prompt }),
});

if (!streamResponse.ok) {
  fail(`stream request returned ${streamResponse.status} ${await streamResponse.text()}`);
}

const raw = await streamResponse.text();
const answer = [...raw.matchAll(/^event: delta\ndata: (.+)$/gm)]
  .map((match) => JSON.parse(match[1]).text)
  .join('');
const doneFrame = raw.match(/^event: done\ndata: (.+)$/m);
const errorFrame = raw.match(/^event: error\ndata: (.+)$/m);

if (errorFrame) {
  fail(`server reported: ${errorFrame[1]}`);
}
console.log(`stream: ${JSON.stringify(answer.trim().slice(0, 60))}`);
if (doneFrame) {
  const done = JSON.parse(doneFrame[1]);
  console.log(`usage: in=${done.inputTokens} out=${done.outputTokens} title=${JSON.stringify(done.title)}`);
}

// Reload from DynamoDB to prove both turns were persisted, not just streamed.
const reloaded = await api(`/api/conversations/${conversation.id}`);
const roles = reloaded.messages.map((message) => message.role).join(',');
console.log(`persisted: ${reloaded.messages.length} messages [${roles}]`);

const listed = await api('/api/conversations');
const present = listed.conversations.some((item) => item.id === conversation.id);
console.log(`sidebar: conversation ${present ? 'present' : 'MISSING'} in list`);

await api(`/api/conversations/${conversation.id}`, { method: 'DELETE' });
const afterDelete = await api('/api/conversations');
const stillThere = afterDelete.conversations.some((item) => item.id === conversation.id);
console.log(`cleanup: conversation ${stillThere ? 'STILL PRESENT' : 'deleted'}`);

const ok =
  answer.includes('DEPLOY_OK') &&
  reloaded.messages.length === 2 &&
  roles === 'user,assistant' &&
  present &&
  !stillThere;

console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
