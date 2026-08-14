# Chorus for Obsidian

An Obsidian plugin that puts a chat panel in your vault, talking to your own
Chorus deployment, to Amazon Bedrock directly, or to Anthropic's API.

This is not published in Obsidian's community plugin directory. You build it from
this folder and copy three files into your vault, which takes about a minute.

## Build and install

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd obsidian-plugin
npm install
npm run build
```

That produces `main.js`. Copy it, along with `manifest.json` and `styles.css`, into
your vault:

```bash
VAULT=~/path/to/your/vault
mkdir -p "$VAULT/.obsidian/plugins/chorus-chat"
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/chorus-chat/"
```

Then in Obsidian: **Settings → Community plugins**, enable **Chorus**. Open the chat
from the speech-bubble icon in the left ribbon, or the **Chorus: Open chat** command.

If Obsidian is already running, reload it with `Cmd/Ctrl+R` after copying files.

## Choose a backend

Open **Settings → Chorus** and pick one. All three send your keys nowhere except
the provider.

### Chorus proxy

Points at a deployment of [the Chorus web app](../README.md). The only option where
**no cloud credentials are stored in your vault** — just a username and password.
AWS keys stay on the server, and the server's daily token budget applies.

You need:

| Setting | Where it comes from |
| --- | --- |
| Base URL | your deployment, e.g. `https://chat.example.com` |
| Cognito region | the region the stack is deployed in |
| App client ID | the `PluginUserPoolClientId` stack output |
| Username / password | a user in the pool |
| Model | a model key from the registry, e.g. `claude-sonnet-4-5` |

The app client matters. The web app's client is SRP-only on purpose, and SRP needs a
browser-grade crypto stack a plugin cannot reasonably carry. The stack therefore
creates a second client permitting `USER_PASSWORD_AUTH`, exposed as the
`PluginUserPoolClientId` output. Using the web client here fails with a message
about password auth not being allowed.

With this backend the transcript lives on the server: the plugin creates one
conversation and reuses it, so the same thread is visible in the web app.

### Amazon Bedrock

A region, an access key and secret, and a model ID. Requests are signed locally with
SigV4; no AWS SDK is bundled.

Two things commonly trip people up:

- **Claude 4.x needs an inference profile.** Use a prefixed model ID such as
  `global.anthropic.claude-sonnet-4-5-20250929-v1:0`. A bare ID fails validation.
  `global.` bills at list price, `us.` adds roughly 10%.
- **The model must be enabled in that region**, and the key needs
  `bedrock:InvokeModel`.

Use a key scoped to Bedrock invocation and nothing else.

### Anthropic API key

The quickest to set up. A key from [console.anthropic.com](https://console.anthropic.com)
and a model such as `claude-sonnet-4-5-20250929`. This works from a plugin because
Obsidian issues the request outside the renderer's origin, so the browser CORS rules
that normally block direct calls do not apply.

## What it does

- **A chat per note**, or one for the whole vault, your choice in settings. The
  panel follows whichever note you are in, and names the open chat in its header.
- **Attach the open note, or just your selection**, as context for a question. The
  chip shows the approximate token cost before you send.
- **Streaming replies** on the Chorus backend, arriving word by word.
- **Copy buttons** on each reply and on every code block. Replies copy as Markdown.
- **Per-turn token usage** and an indicative cost, revealed on hover.

## How note chats are stored

A note's chat is pointed to from the note's own frontmatter:

```markdown
---
chorus-chat: 7f3a9c12-4b1e-4a55-9c0d-2f8e1a6b3d90
---
```

The transcript itself lives beside the plugin, named after that ID:

```
.obsidian/plugins/chorus-chat/chats/7f3a9c12-....json
```

The note stores an **ID rather than a path**, which is the whole point: renaming or
moving a note changes nothing, because the pointer travels inside the file and the
transcript's name never depended on where the note lived. Keying transcripts by path
would need rename tracking, and would still miss renames made outside Obsidian or
arriving through sync.

**Nothing is written until a reply arrives.** Opening a note does not touch it. The
header shows the note name with a `new chat` label, and the turn is held in memory
only. The frontmatter line and the transcript file appear together, once the model has
actually answered. So browsing a hundred notes creates nothing, and a failed send
leaves no trace.

The vault-wide chat lives in `history.json` and is used when no note is open, or when
the scope setting is set to one chat for the vault.

Deleting a note leaves its transcript behind on purpose. It is a few kilobytes of
JSON, and silently destroying a conversation because a note moved to the bin is worse
than leaving a file nobody reads.

## Security

Obsidian stores plugin settings in `data.json` inside the plugin folder, in **plain
text**, and that file syncs wherever your vault syncs. Any key you paste in is
readable by anything that can read your vault.

Prefer a narrowly scoped key, prefer the proxy backend if you have one, and do not
put an admin credential in here.

## Limitations

- **Streaming needs CORS.** The Chorus server allows Obsidian's origins
  (`app://obsidian.md` and the mobile localhost forms). Without that the plugin still
  works, falling back to waiting for the whole reply.
- **Bedrock cannot stream here.** Bedrock does not support CORS, and its streaming
  API uses a binary framing that would need a hand-written parser.
- **No tool use, no vault-wide search.** It is a chat panel, not an agent. Nothing is
  read from your notes unless you attach it.

## Development

```bash
npm run dev     # rebuild on change
npm run check   # typecheck only
npm run build   # typecheck, then produce a minified main.js
```

Symlink this folder into a vault's `.obsidian/plugins/` directory to iterate without
copying after every build.

Layout:

```
src/main.ts                 plugin entry, commands, single-panel enforcement
src/view.ts                 the chat panel
src/settings.ts             settings model and UI
src/history.ts              the vault's transcript
src/noteContext.ts          tracks the open note and its selection
src/providers/index.ts      backend factory and the rate table
src/providers/chorus.ts     Cognito auth, streaming and buffered calls
src/providers/bedrock.ts    Bedrock Converse
src/providers/anthropic.ts  Anthropic Messages
src/providers/sigv4.ts      request signing, no SDK
```

Adding a backend means implementing the `Backend` interface in `src/types.ts` and
registering it in the factory. Nothing else changes.
