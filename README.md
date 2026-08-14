# Chorus

**Many models. One conversation.**

A private, self-hosted chat web app that puts Claude and Grok behind a single
interface, running entirely in your own AWS account through Amazon Bedrock. Every
token is billed to you, no third-party service sits in the middle, and no AWS
credentials ever reach the browser.

Built to be used from a phone as comfortably as a laptop.

---

## Why this exists

Managed AI chat products are convenient but you don't control the data path, the
model list, or the bill. Bedrock gives you frontier models from several vendors
behind an AWS-native API, so this project is the missing piece: a small,
auditable web app in front of it with real authentication, persistent history and
sane cost controls.

It is deliberately small. One EC2 instance, one DynamoDB table, one Cognito user
pool, one CloudFront distribution. Everything is in a single CloudFormation
template you can read in one sitting.

## Features

- **Multiple model families** in one interface: Claude Sonnet 4.5, Claude Opus
  4.5 and Grok 4.3, chosen per conversation
- **Streaming replies** token by token, with a stop button
- **Persistent history** per user, grouped by recency
- **Real authentication** via Cognito with SRP, admin-created accounts only
- **Mobile-first UI**: keyboard-safe layout, safe-area insets, off-canvas drawer
- **Markdown rendering** with syntax highlighting and copy-to-clipboard
- **No credentials in the browser** — the client holds only a JWT
- **Closed origin** — the instance accepts traffic from CloudFront alone
- **Per-turn token usage** with an indicative cost, shown on hover
- **Cost guardrails** — per-user daily token caps and budget alerts, because
  Bedrock enforces no spend ceiling of its own
- **An [Obsidian plugin](#obsidian-plugin)** with a chat per note, which can attach
  the open note or a selection as context

## Models

| Model | Endpoint | API | Identifier |
| --- | --- | --- | --- |
| Claude Sonnet 4.5 (default) | `bedrock-runtime` | Converse | `global.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| Claude Opus 4.5 | `bedrock-runtime` | Converse | `global.anthropic.claude-opus-4-5-20251101-v1:0` |
| Grok 4.3 | `bedrock-mantle` | Chat Completions | `xai.grok-4.3` |

### Global profiles, not geo profiles

Claude uses the `global.` prefix rather than `us.`. Geo profiles bill roughly 10%
above list price; global profiles bill at list. Measured on this deployment,
`global.` was no slower — time to first token was 12% *faster* for Sonnet and
within 1% for Opus, both inside run-to-run variance:

```
Sonnet 4.5  us     ttft median 2072ms    global  1829ms
Opus 4.5    us     ttft median 1502ms    global  1517ms
```

So global is cheaper at equal latency. The tradeoff is that it routes wherever AWS
has capacity, so switch back to `us.` if you need US data residency.

One IAM detail: a global profile's model list includes a **Region-less**
foundation-model ARN (`arn:aws:bedrock:::foundation-model/...`). Omit it and calls
fail with AccessDenied even though the profile ARN is allowed.

Bedrock splits inference across two endpoints and the correct identifier form is
not guessable from the model name, so `server/src/models.js` declares each one
explicitly. Claude 4.x has no on-demand throughput and must be addressed through a
cross-region inference profile — the `us.` prefix. Grok lives on the
OpenAI-compatible `bedrock-mantle` endpoint and is in-region only.

The model is picked before a conversation starts and then fixed, because switching
mid-thread produces replies that disagree with the history above them.

### Adding a model

Add an entry to `server/src/models.js` with its `transport` and the identifier
from its AWS model card, then extend the IAM policy in `infra/template.yaml`.
Model IDs should be copied from the model card, not inferred — see
[Lessons learned](#lessons-learned).

## Architecture

```
Browser ──HTTPS──> CloudFront ──HTTPS──> Caddy ──> Node/Express ──> Bedrock Converse (Claude)
   │               ai.<domain>          origin.<domain>   │      ──> Bedrock Mantle   (Grok)
   │                                                      └──────>  DynamoDB         (history)
   └──SRP auth──> Cognito user pool
```

| Layer | Choice | Reason |
| --- | --- | --- |
| Edge | CloudFront + ACM | TLS, and the only way into the origin |
| Origin TLS | Caddy + Let's Encrypt (DNS-01) | keeps the CloudFront hop encrypted |
| App | Node 22 + Express | one process serves the SPA and the API |
| Frontend | React + Vite + Tailwind | static bundle, no SSR needed |
| Auth | Cognito user pool (SRP) | no password handling of our own |
| Storage | DynamoDB, single table | on-demand, no capacity planning |
| Compute | one `t4g.small` | ~$12-15/month |

### Repository layout

```
server/     Express API, provider adapters, DynamoDB access
  src/providers/    one adapter per Bedrock endpoint
  scripts/          live verification against real Bedrock
web/        React frontend
infra/      CloudFormation template and packaging script
obsidian-plugin/  companion Obsidian plugin, talks to this API
```

### Data model

One DynamoDB table:

```
pk              sk                     entity
USER#<sub>      CONV#<updatedAt>#<id>  conversation index entry
CONV#<id>       META                   conversation record
CONV#<id>       MSG#<seq>              message
USER#<sub>      USAGE#<yyyy-mm-dd>     daily token counter
```

The index entry is keyed by `updatedAt`, so listing a user's conversations in
recency order is a single query with no secondary index. Ownership is checked in
the data layer, so a guessed UUID cannot read someone else's thread.

## Deploying

Prerequisites: an AWS account with Bedrock model access enabled, a Route 53
hosted zone, and the AWS CLI configured.

**1. Upload the application bundle**

```bash
aws s3 mb s3://YOUR_BUCKET
./infra/package.sh s3://YOUR_BUCKET/chorus/app.tar.gz
```

The bucket is deliberately outside the template: the bundle must already exist in
S3 before the instance boots and runs its user data.

**2. Choose a VPC and public subnet**

The template takes an existing VPC because the default quota is 5 VPCs per Region
and creating one fails the whole stack once you hit it. Check that your chosen VPC
is not associated with a private hosted zone shadowing an AWS service domain,
which can hijack Bedrock DNS:

```bash
aws route53 list-hosted-zones --query 'HostedZones[?Config.PrivateZone].[Name,Id]' --output text
```

The subnet must auto-assign public IPs, since user data needs outbound internet
before the Elastic IP attaches.

**3. Deploy**

```bash
aws cloudformation deploy \
  --template-file infra/template.yaml \
  --stack-name chorus \
  --capabilities CAPABILITY_IAM \
  --region us-east-1 \
  --parameter-overrides \
    HostedZoneId=YOUR_ZONE_ID \
    DomainName=chat.example.com \
    VpcId=vpc-xxxxxxxx \
    SubnetId=subnet-xxxxxxxx \
    ArtifactS3Uri=s3://YOUR_BUCKET/chorus/app.tar.gz \
    BudgetAlertEmail=you@example.com
```

Certificate issuance needs DNS to resolve first, so HTTPS may take a few minutes
on a cold deploy. Confirm the SNS subscription email, or budget alerts go nowhere.

**4. Create accounts**

Self-service signup is disabled, so accounts exist only if you create them:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId output> \
  --username alice \
  --temporary-password 'ChangeMe-12345' \
  --message-action SUPPRESS
```

Share the username and temporary password; the app prompts for a permanent one on
first sign-in. Each user gets their own history. Revoke one person without
affecting anyone else:

```bash
aws cognito-idp admin-disable-user --user-pool-id <pool> --username alice
```

**Redeploying code** needs a user data re-run, because CloudFormation updates
`UserData` in place without replacing the instance:

```bash
aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters 'commands=["TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H \"X-aws-ec2-metadata-token-ttl-seconds: 300\")","curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" http://169.254.169.254/latest/user-data -o /tmp/u.sh","bash /tmp/u.sh"]'
```

The script is idempotent and ends with `systemctl restart`, not `enable --now`,
which on a running instance is a no-op that would leave the old process alive.

## Local development

The server needs a real Cognito pool and DynamoDB table, so deploy first and point
local config at the stack outputs.

```bash
cd server && npm install
AWS_REGION=us-east-1 MANTLE_REGION=us-east-2 \
TABLE_NAME=... COGNITO_USER_POOL_ID=... COGNITO_CLIENT_ID=... \
npm run dev

cd ../web && npm install && npm run dev   # proxies /api to :8080
```

`ORIGIN_SECRET` is unset locally, which disables the CloudFront origin check.

### Verification

```bash
cd server
npm run check                                  # syntax check every module
node scripts/verify-mantle-token.js            # bearer token against live Grok
node scripts/verify-providers.js               # stream from all three models
node scripts/check-grok-regions.js             # is Grok healthy, and where
node scripts/verify-deployment.js https://chat.example.com USER PASS [modelId]
```

`verify-deployment.js` signs in with SRP exactly as the browser does, confirms an
unauthenticated request is rejected with 401, streams a reply, reloads the thread
from DynamoDB to prove both turns persisted, then deletes it. **Run it per model**
— the two Bedrock endpoints authorise differently, so Claude passing does not mean
Grok will.

## Obsidian plugin

[`obsidian-plugin/`](obsidian-plugin/) is a companion plugin that puts a chat panel
inside an [Obsidian](https://obsidian.md) vault. It is not published in Obsidian's
community directory: you build it from this repository and copy three files into your
vault, which takes about a minute. See its
[README](obsidian-plugin/README.md) for setup.

It can talk to this deployment over Cognito, or straight to Bedrock with an AWS key,
or to Anthropic's API. The proxy option is the interesting one, because it is the only
configuration where **no cloud credentials sit in the vault** — Obsidian stores plugin
settings as plain text in a file that syncs wherever the vault syncs, so keeping AWS
keys server-side matters more than it might seem.

### What it took on the server side

Three changes here, all small, all in this repository:

**A second Cognito app client.** The web client is deliberately SRP-only, so the
password is never transmitted to Cognito even in encrypted form. SRP needs a
browser-grade crypto stack that an Obsidian plugin cannot reasonably carry, so the
stack creates a separate client permitting `USER_PASSWORD_AUTH`, exposed as the
`PluginUserPoolClientId` output. A second client rather than an extra flow on the
first: the browser keeps its stronger guarantee, and the weaker client can be revoked
on its own if a vault leaks.

**Two accepted client IDs.** Access tokens name the client that minted them, so
`auth.js` validates against both rather than switching the check off.

**CORS on `/api`, scoped to Obsidian's origins.** Only needed for streaming.
Obsidian's own HTTP helper bypasses CORS but buffers the entire response, so replies
landed in one lump. Real streaming needs the platform `fetch`, which is subject to
origin checks. Credentials are deliberately not allowed in that policy: auth is a
bearer token rather than a cookie, so there is nothing for a hostile page to replay.

The CloudFront behaviour for `/api/*` needed no change, because it already disabled
caching, allowed `OPTIONS`, and — importantly — had compression switched off.
CloudFront buffers while compressing, which silently defeats `text/event-stream`.

### Notable pieces on the plugin side

**SigV4 by hand.** The Bedrock backend signs requests itself rather than bundling the
AWS SDK, which would add megabytes and pull in Node built-ins absent on mobile. Worth
knowing if you read that code: every AWS service except S3 expects the canonical
request path encoded *twice*, so a colon in a model ID appears as `%253A` in the
string to sign. Getting it wrong returns a 403 whose message blames your secret key.

**Attaching notes costs tokens on every later turn.** The plugin sends the note with
the question, and the server then stores it as part of that message and replays it for
the rest of the conversation. The attachment chip shows an approximate token count
before you send for exactly this reason. This is the same history-resending cost
described in [How conversation context works](#how-conversation-context-works-and-what-it-costs),
just with a larger first message.

## Security

- No AWS credentials in the browser; it holds only a Cognito JWT, verified on
  every request
- Conversation ownership enforced in the data layer, not the route
- The origin admits only the AWS-managed CloudFront prefix list
  (`com.amazonaws.global.cloudfront.origin-facing`) on 443 — no open CIDR anywhere
- That prefix list covers *every* CloudFront distribution, so the origin also
  validates a secret header from Secrets Manager and returns 403 without it
- TLS end to end: ACM at the edge, Let's Encrypt at the origin, so JWTs never
  cross the internet in the clear
- No SSH ingress; shell access via SSM Session Manager
- IMDSv2 required, so an SSRF bug cannot reach instance credentials
- Mantle access restricted to short-term bearer tokens
- DynamoDB table is `Retain` on delete

### Cost controls

Bedrock has **no spend ceiling**. A bug or a leaked password means unbounded token
spend, so:

- IAM restricts Claude to specific model ARNs
- `maxTokens` enforced server-side, never accepted from the client
- Per-user daily output-token cap in DynamoDB, surfaced in the UI, 429 when spent
- Replay trimmed to recent turns so long threads don't grow cost without bound
- AWS Budget alerts at 80% actual and 100% forecast, to email and SNS, **scoped to
  Bedrock only** so it tracks model spend rather than everything else in the
  account

The budget filters on the Cost Explorer service name, which is
`Amazon Bedrock Service` — not `Amazon Bedrock`. A filter on the shorter name
matches nothing and the budget silently tracks $0 forever. Verify for your account
with `aws ce get-dimension-values --dimension SERVICE`.

Because the budget is Bedrock-scoped, infrastructure spend (EC2, CloudFront,
DynamoDB, Elastic IP) is deliberately *not* covered by it. Add a second unfiltered
budget if you want total-spend cover.
- Closing the browser aborts the upstream call, so an abandoned tab stops billing

---

## Lessons learned

Things that cost real debugging time, kept here because they are not obvious from
the documentation.

**Bedrock has two endpoints that authorise completely differently.**
`bedrock-runtime` uses `bedrock:InvokeModel` against model ARNs.
`bedrock-mantle` has its own IAM namespace and gates inference as
`bedrock-mantle:CreateInference` against a **project** resource. Grok failed with
AccessDenied while Claude worked, using a policy that looked correct.

**Mantle inference cannot be scoped to one model via IAM.** The resource is a
project, not a model, so the grant permits any Mantle model in the account. The
server-side registry and token budget are the real constraint.

**Inference profiles route across Regions.** A `us.` profile can serve from any of
three Regions, so the policy must permit the underlying model in all of them.
Allowing only the local Region works until Bedrock reroutes under load, then fails
with an opaque AccessDenied at the worst possible moment.

**Model IDs are not guessable and the catalog API doesn't list everything.**
`ListFoundationModels` only covers `bedrock-runtime`, so Mantle models are
invisible to it — they look unavailable when they aren't. Take IDs from the AWS
model cards.

**`AllViewer` breaks a custom origin.** CloudFront derives origin SNI from the
`Host` header, so `AllViewer` asks the origin for a certificate for the *viewer*
domain. Every request fails the TLS handshake and surfaces as a bare 502 with
nothing in the application log. Use `AllViewerExceptHostHeader`.

**CloudFront compression defeats SSE.** It buffers while compressing, turning a
streaming reply into one delayed blob. Disable it on streaming paths.

**Closing the origin breaks ACME HTTP-01 silently.** Certificates issue fine on
first boot and then fail to renew about 60 days later. DNS-01 needs no inbound
port.

**Reasoning tokens come out of the output budget.** A too-small `maxTokens`
returns an empty message because reasoning consumed all of it. Grok also bills
reasoning tokens without returning the trace on Chat Completions — only the
Responses API exposes it.

**In-region-only models have no failover.** Grok timed out on every request in one
Region while another answered in two seconds. `MANTLE_REGION` is separate from the
stack Region for exactly this reason.

**`set -x` in user data leaks secrets** into cloud-init logs. Disable tracing
around secret fetches.

**Dynamic references don't re-resolve on value change.** CloudFormation diffs
template text, so rotating a secret leaves the old value in the distribution while
the instance reads the new one, and everything 403s. Pass the version ID.

**cfn-lint catches errors AWS's own docs contain.** The documented Mantle policy
lists `ListTagsForResources`, which is not a real action — it is singular. IAM
accepts unknown action names silently, so it was a dead grant.

## How conversation context works, and what it costs

Bedrock inference is **stateless**. The model retains nothing between requests, so
there is no session to resume. What gets called "context" is not memory — it is the
input payload of a single request, and the context window is the maximum size of
that payload rather than a store the model fills up over time.

Continuity is therefore the client's job. On every turn this app reads the whole
thread back out of DynamoDB and sends it again:

```js
const replay = [...history, { role: 'user', content }]
  .slice(-MAX_HISTORY_MESSAGES)
  .map(({ role, content: text }) => ({ role, content: text }));
```

The consequence is that **input grows quadratically** with conversation length.
Turn 1 sends one message, turn 20 sends nineteen, so total input across a thread is
proportional to the square of its length. For a 20-turn conversation of ~200-token
messages that is roughly 81,000 input tokens against 4,000 output tokens — and at
Sonnet rates input then costs about four times more than output despite being five
times cheaper per token.

Two things follow. The daily cap counts output tokens only, so it does not
constrain the side that actually drives the bill. And an attached file is paid for
on *every* subsequent turn, not once.

`MAX_HISTORY_MESSAGES` (default 40) is the current mitigation: a long thread
silently drops its oldest turns.

## Possible extensions

Deliberately not built. Recorded here because the design work is done and the
tradeoffs are known.

**Prompt caching** is the highest-value change. Bedrock bills a cached input prefix
at roughly 10% of the normal rate, which is close to a 90% discount on the resent
history:

```
cache-read-input-token-count    $0.50/M    (vs $5.00/M input, Opus)
cache-write-input-token-count   $6.25/M    (1.25x, paid once)
```

**Trim by token budget rather than message count.** `MAX_HISTORY_MESSAGES` treats a
one-word reply and a 25,000-token attachment as equally expensive, so two users on
the same limit can differ by 100x in real cost. Walking backwards through history
accumulating tokens until a ceiling is reached gives a genuine per-turn cost bound,
and makes a large attachment displace old turns instead of riding along with all of
them. Every message row already stores `inputTokens` and `outputTokens`, so the
data is there.

**Per-user limits.** The history budget can be resolved per user rather than
globally. Two reasonable places for it:

- *Cognito groups* — membership already travels in the access token as
  `cognito:groups`, so a group-to-limit map costs no extra reads and is managed with
  one CLI command per user. Best for a few tiers.
- *A DynamoDB settings row* (`pk=USER#<sub>`, `sk=SETTINGS`) — arbitrary values per
  person, and it can share the query the chat route already makes against that
  partition. Best for a dial per user.

A Cognito *custom attribute* looks tidiest but appears only in the ID token, while
this app verifies the access token, so it would need a pre-token-generation Lambda.
Custom attributes also cannot be removed from a pool schema once added.

Whichever is chosen, the limit must be resolved server-side from identity and never
accepted from the client, and it should be a token budget rather than a message
count — building tiers on message count builds them on the wrong unit. A larger
history budget also means quadratically more input spend, so this pairs with
counting input tokens in `addUsage`, which currently records output only.

**Automatic cleanup of orphaned conversations.** Deleting a Cognito user leaves
their rows in DynamoDB keyed by a `sub` that no longer resolves. A CloudTrail
EventBridge rule on `AdminDeleteUser` can trigger a Lambda, but the event carries a
username and the table is keyed by `sub` — and the user is already gone, so the two
cannot be mapped. The workable design ignores the event payload and runs
scan-and-diff against live Cognito subs, paired with a scheduled sweep, since
orphans also arise from causes other than deletion.

**File attachments** for `.txt` and `.md` in the web app. No S3 needed: read in the
browser and send as text. The open question is cost, given attachments are resent
every turn. The [Obsidian plugin](#obsidian-plugin) already does this for notes, and
shows an approximate token count before sending; the same affordance would work here.

**WAF** on the CloudFront distribution for rate limiting.

## Known gaps

- **No reasoning trace for Grok** — billed but not returned on Chat Completions
- **Single instance** — no redundancy, a reboot is downtime
- **No WAF** — the distribution is ready for a web ACL if you want rate limiting
- **Frontend bundle is ~590 KB** (182 KB gzipped), dominated by the Cognito SDK
  and Markdown tooling; code-splitting would help first paint
- **GPT-5.6 not wired up** — available on Bedrock via Mantle's Responses API, but
  it needs a separate provider adapter and a model subscription

## License

MIT — see [LICENSE](LICENSE).
