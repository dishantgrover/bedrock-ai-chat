# AI Chat on Amazon Bedrock

Private, multi-user chat web app fronting Claude and Grok through Amazon Bedrock.
All inference is billed to the AWS account that hosts it. The browser never holds
AWS credentials; it authenticates to Cognito and the server calls Bedrock with an
instance role.

## Models

| Model | Endpoint | API | Identifier |
| --- | --- | --- | --- |
| Claude Sonnet 4.5 (default) | `bedrock-runtime` | Converse | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| Claude Opus 4.5 | `bedrock-runtime` | Converse | `us.anthropic.claude-opus-4-5-20251101-v1:0` |
| Grok 4.3 | `bedrock-mantle` | Chat Completions | `xai.grok-4.3` |

Bedrock splits inference across two endpoints. Claude 4.x has no on-demand
throughput, so it must be addressed through a cross-region inference profile —
the `us.` prefix. Grok lives on the OpenAI-compatible `bedrock-mantle` endpoint
and is in-region only. The identifier form is not guessable from the model name,
so `server/src/models.js` declares each one explicitly.

The model is chosen before a conversation starts and then fixed, so replies never
disagree with the history above them.

### Not included: GPT-5.6

`openai.gpt-5.6-sol` / `-terra` / `-luna` are available on Bedrock but were left
out. They are Mantle **Responses API** only (not Chat Completions), and the model
subscription was still provisioning in this account. Adding one later is a config
entry in `models.js` plus a Responses-API provider.

## Architecture

```
Browser  ──HTTPS──>  Caddy (TLS)  ──>  Node/Express  ──>  Bedrock Converse   (Claude)
   │                                        │         ──>  Bedrock Mantle     (Grok)
   │                                        └────────────>  DynamoDB          (history)
   └──SRP auth──>  Cognito user pool
```

Single EC2 instance. Caddy obtains and renews certificates over ACME. The Node
process serves both the built frontend and the API, and relays model output to
the browser as Server-Sent Events.

## Layout

```
server/   Express API, provider adapters, DynamoDB access
web/      React + Vite + Tailwind frontend
infra/    CloudFormation template and packaging script
```

## Local development

The server needs a real Cognito pool and DynamoDB table, so deploy the stack
first and point local config at its outputs.

```bash
cd server
npm install
AWS_REGION=us-east-1 \
TABLE_NAME=<from stack output> \
COGNITO_USER_POOL_ID=<from stack output> \
COGNITO_CLIENT_ID=<from stack output> \
npm run dev

cd ../web
npm install
npm run dev      # proxies /api to localhost:8080
```

### Verification scripts

```bash
cd server
npm run check                              # syntax check all modules
node scripts/verify-mantle-token.js        # bearer token against live Grok
node scripts/verify-providers.js           # stream from all three models
```

`verify-providers.js` exercises the same code path as the chat route, so an SDK
response-shape change surfaces there rather than in the browser.

## Deploying

1. Create an S3 bucket for the application bundle, then build and upload:

   ```bash
   ./infra/package.sh s3://my-bucket/ai-chat/app.tar.gz
   ```

   The bucket is created outside the template on purpose: the bundle has to exist
   in S3 before the instance boots and runs its user data, so it cannot be a
   resource in the same stack.

2. Optional, for SMS alerts. While the account is in the SNS SMS sandbox, verify
   the destination number first:

   ```bash
   aws sns create-sms-sandbox-phone-number --phone-number '+14155550123' --region us-east-1
   aws sns verify-sms-sandbox-phone-number --phone-number '+14155550123' --one-time-password 123456 --region us-east-1
   ```

   Sandbox restricts destinations, not senders, so verifying your own number is
   enough — no production access request needed. Indian (+91) destinations also
   require TRAI DLT registration; without it SNS accepts the publish and the
   message is dropped silently. The default `MonthlySpendLimit` is $1, which is
   plenty for alerts but will throttle if exceeded.

3. Deploy. The stack creates its own VPC, subnet, internet gateway and route
   table, so nothing needs to be picked from existing infrastructure:

   ```bash
   aws cloudformation deploy \
     --template-file infra/template.yaml \
     --stack-name ai-chat \
     --capabilities CAPABILITY_IAM \
     --region us-east-1 \
     --parameter-overrides \
       HostedZoneId=Z0182472332CFDCGDQA2V \
       DomainName=ai.dishantgrover.com \
       ArtifactS3Uri=s3://my-bucket/ai-chat/app.tar.gz \
       BudgetAlertEmail=you@example.com \
       AlertPhoneNumber=+14155550123
   ```

   Certificate issuance needs the DNS record to resolve to the Elastic IP first.
   Caddy retries, so the site may take a few minutes to serve HTTPS on a cold
   deploy.

   Confirm the email subscription when AWS sends it, or budget alerts go nowhere.

4. Create the login. Self-service signup is disabled, so accounts only exist if
   you create them:

   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id <UserPoolId output> \
     --username team \
     --temporary-password 'ChangeMe-12345' \
     --message-action SUPPRESS \
     --region us-east-1
   ```

   This deployment uses a **single shared account** handed out to peers. The app
   prompts for a permanent password on first sign-in, so whoever signs in first
   sets it — do that yourself before sharing.

   Consequences of the shared account, by design:

   - Everyone sees the same conversation list. There is no per-person privacy.
   - The daily token budget is shared across all users, not per person.
   - Revoking one person means rotating the password for everybody.

   Switching to per-user accounts later needs no code change — just create more
   users, since history is already partitioned by Cognito `sub`:

   ```bash
   aws cognito-idp admin-create-user --user-pool-id <pool> --username alice ...
   aws cognito-idp admin-disable-user --user-pool-id <pool> --username alice
   ```

## Cost controls

Bedrock has **no spend ceiling**. A bug or a leaked password means unbounded
token spend, so the stack layers several guardrails:

- IAM allows only the three model ARNs above; no other model can be invoked.
- `maxTokens` is enforced server-side and never accepted from the client.
- Per-user daily output-token cap in DynamoDB (`DailyTokenBudget`, default
  200,000), surfaced in the sidebar and returning HTTP 429 when exhausted.
- Conversation replay is trimmed to the most recent turns, so a long thread does
  not grow cost without bound.
- An AWS Budget alerts on 80% actual and 100% forecast spend, via email and an
  SNS topic that fans out to SMS.

### Slack alerts

Not wired up. AWS Chatbot requires its Slack app to be installed and approved by
a workspace administrator plus a browser OAuth consent flow, which rules out
admin-locked corporate workspaces. Its API is also only available in a subset of
Regions — `us-east-2` and `us-west-2`, not `us-east-1`.

To add Slack in a workspace you control, subscribe a Lambda to the
`AlertTopicArn` output and have it POST to an incoming webhook. Keep the webhook
URL in Secrets Manager rather than an environment variable, since it is a
credential that grants posting rights to the channel.
- Closing the browser aborts the upstream Bedrock call, so an abandoned tab stops
  billing.

Roughly $12-15/month for the `t4g.small` and Elastic IP, plus per-token Bedrock
usage and negligible DynamoDB spend.

## Security notes

- No AWS credentials in the browser. It holds only a Cognito JWT; every API
  request is verified against the user pool.
- Conversation ownership is checked in the data layer, so a guessed UUID cannot
  read another user's thread.
- No SSH ingress. Shell access is via Session Manager.
- IMDSv2 required, so an SSRF bug in the app cannot reach instance credentials
  through the legacy metadata endpoint.
- Mantle access is restricted to short-term bearer tokens; long-term Bedrock API
  keys are standing credentials this app never needs.
- The DynamoDB table is `Retain` on delete, so tearing down the stack does not
  destroy chat history.

## Known gaps

- **No reasoning trace for Grok.** Grok reasons internally and those tokens are
  billed, but Chat Completions does not return the trace — only the Responses API
  does. Verified against the live endpoint: 406 output tokens billed, zero
  reasoning deltas. The UI does not show a panel that would never fill.
- **Single instance.** No redundancy; a reboot is downtime.
- **New bundles need an instance replacement.** User data only runs at first
  boot, so `package.sh` alone does not redeploy code.
- **Frontend bundle is ~590 KB** (182 KB gzipped), dominated by the Cognito SDK
  and Markdown/highlighting. Fine over HTTPS with compression, but code-splitting
  would help first paint on mobile.
