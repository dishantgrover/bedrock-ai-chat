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

### Grok runs in us-east-2

Grok is in-region only. It has no geo or global inference profile, so unlike
Claude there is nothing to route around a Region having a bad day.

us-east-1 was observed timing out on every Grok request while us-east-2 answered
in about two seconds, so `MANTLE_REGION` pins Mantle traffic separately from the
rest of the stack. If Grok starts failing, check whether it is regional before
suspecting this code:

```bash
node server/scripts/check-grok-regions.js
```

Two things to remember when changing it: the bearer token must be signed for the
same Region as the endpoint it is sent to, and the IAM `project` resource is
Region-scoped, so the policy has to name the same Region.

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
Browser ──HTTPS──> CloudFront ──HTTPS──> Caddy ──> Node/Express ──> Bedrock Converse (Claude, us-east-1)
   │               ai.<domain>          origin.<domain>   │      ──> Bedrock Mantle   (Grok, us-east-2)
   │                                                      └──────>  DynamoDB         (history)
   └──SRP auth──> Cognito user pool
```

The instance is never exposed to the internet at large. Its security group admits
only the AWS-managed CloudFront prefix list
(`com.amazonaws.global.cloudfront.origin-facing`) on 443, and there is no open
CIDR rule anywhere.

That prefix list covers *every* CloudFront distribution, including other AWS
customers', so it is not sufficient alone. CloudFront also attaches a secret
header from Secrets Manager that the origin validates, rejecting anything else
with a 403. Prefix list plus shared secret together are what make the restriction
real.

TLS terminates twice and is never absent: ACM at CloudFront for the viewer, and a
Let's Encrypt certificate at Caddy for the CloudFront-to-origin hop. Cognito JWTs
therefore never cross the public internet in the clear.

Caddy validates over **DNS-01** against Route 53 rather than HTTP-01, because no
inbound port is open to the ACME servers. This is not optional once the origin is
closed: an HTTP-01 setup issues fine on first boot and then silently fails to
renew about 60 days later.

Grok runs in a **different Region** to everything else. See the note under Models.

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

# Full authenticated path against a deployed environment
node scripts/verify-deployment.js https://ai.example.com USER PASSWORD [modelId]
```

`verify-providers.js` exercises the same code path as the chat route, so an SDK
response-shape change surfaces there rather than in the browser.

`verify-deployment.js` signs in with SRP exactly as the browser does, then checks
that an unauthenticated request is rejected with 401, streams a reply, reloads the
thread from DynamoDB to prove both turns persisted, and deletes it again. Run it
per model — the two endpoints authorise differently, so Claude passing does not
mean Grok will.

## Deploying

1. Create an S3 bucket for the application bundle, then build and upload:

   ```bash
   ./infra/package.sh s3://my-bucket/ai-chat/app.tar.gz
   ```

   The bucket is created outside the template on purpose: the bundle has to exist
   in S3 before the instance boots and runs its user data, so it cannot be a
   resource in the same stack.

   Pick an existing VPC and a public subnet. The template originally created its
   own VPC, which is preferable for isolation, but the default quota is 5 VPCs
   per Region and hitting it fails the whole stack with
   `ServiceLimitExceeded`. Raise the quota via Service Quotas if you want a
   dedicated VPC. Whichever VPC you choose, confirm it is not associated with a
   private hosted zone that shadows an AWS service domain:

   ```bash
   aws route53 list-hosted-zones --query 'HostedZones[?Config.PrivateZone].[Name,Id]' --output text
   aws route53 get-hosted-zone --id <zone-id> --query 'VPCs[].VPCId'
   ```

   The subnet should auto-assign public IPs, since user data needs outbound
   internet access before the Elastic IP is attached.

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

- IAM restricts Claude to the two model ARNs above. See the caveat below for why
  the same is not achievable for Grok.
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

## IAM: the two endpoints authorise differently

This caused the only real deployment failure, so it is worth stating plainly.

**`bedrock-runtime` (Claude)** uses `bedrock:InvokeModel` /
`InvokeModelWithResponseStream` against foundation-model and inference-profile
ARNs. Because a `us.` profile can route to `us-east-1`, `us-east-2` or
`us-west-2`, the policy must permit the underlying model in all three. Allowing
only the local Region works until Bedrock reroutes under load, then fails with an
opaque AccessDenied.

**`bedrock-mantle` (Grok)** does not use `bedrock:InvokeModel` at all. It has its
own IAM namespace, and inference is authorised as:

```
bedrock-mantle:CreateInference  on  arn:aws:bedrock-mantle:<region>:<account>:project/default
```

The resource is a *project*, not a model. Two consequences:

1. **Mantle inference cannot be scoped to a single model via IAM.** This grant
   permits any Mantle model in the account, not just Grok. What actually
   constrains model choice is the server-side registry in
   `server/src/models.js` plus the per-user token budget. Scoping the resource to
   the default project is still tighter than the `Resource: "*"` the AWS docs
   suggest.
2. Authentication is a separate action from authorisation. The bearer token is
   gated by `bedrock-mantle:CallWithBearerToken`, restricted here to
   `SHORT_TERM`, while the inference itself is gated by `CreateInference`. Both
   are required.

One documentation bug to be aware of: the AWS example policy lists
`bedrock-mantle:ListTagsForResources`, which is not a real action — the correct
name is singular, `ListTagsForResource`. IAM accepts unknown action names without
complaint, so the plural form is a silently dead grant. cfn-lint catches it.

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

## CloudFront gotchas that cost real debugging time

**Use `AllViewerExceptHostHeader`, not `AllViewer`.** CloudFront derives origin
SNI from the `Host` header. `AllViewer` forwards the viewer's Host, so the origin
is asked for a certificate for the *viewer* domain, which it does not hold. Every
request fails the TLS handshake and surfaces as a bare 502 with nothing in the
application log. Caddy debug logging is what reveals it:

```
tls.handshake  no certificate matching TLS ClientHello  server_name=ai.<domain>
http.stdlib    TLS handshake error: no certificate available for 'ai.<domain>'
```

**Compression must be off on `/api/*`.** CloudFront buffers while compressing,
which defeats `text/event-stream` and turns a streaming reply into one delayed
blob.

**Rotating the origin secret needs `OriginSecretVersionId`.** CloudFormation
builds changesets by diffing template text, so a `{{resolve:secretsmanager:...}}`
reference is not re-resolved when only the secret value changed — the distribution
keeps serving the old header while the instance reads the new one, and every
request 403s. Pass the new version ID to make the change visible.

**Origin read timeout is 30s by default, 60s maximum.** A reasoning model can
exceed that before its first token, which CloudFront treats as origin failure.
The server writes an SSE comment immediately and heartbeats every 10 seconds
during silence, which is what actually keeps the connection alive.

## Known gaps

- **No reasoning trace for Grok.** Grok reasons internally and those tokens are
  billed, but Chat Completions does not return the trace — only the Responses API
  does. Verified against the live endpoint: 406 output tokens billed, zero
  reasoning deltas. The UI does not show a panel that would never fill.
- **Single instance.** No redundancy; a reboot is downtime.
- **Redeploying code needs user data re-run.** CloudFormation updates `UserData`
  in place without replacing the instance, so a new bundle is not picked up on its
  own. Re-run it over SSM:

  ```bash
  aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
    --parameters 'commands=["TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H \"X-aws-ec2-metadata-token-ttl-seconds: 300\")","curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" http://169.254.169.254/latest/user-data -o /tmp/u.sh","bash /tmp/u.sh"]'
  ```

  The script is idempotent and ends with `systemctl restart`, not
  `enable --now`, which on a running instance is a no-op and would leave the old
  process in place.
- **Frontend bundle is ~590 KB** (182 KB gzipped), dominated by the Cognito SDK
  and Markdown/highlighting. Fine over HTTPS with compression, but code-splitting
  would help first paint on mobile.
