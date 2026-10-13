# opencode-quota

a multi-account quota watch for [opencode](https://opencode.ai). it keeps the
remaining usage of every connected account in your footer, so you can see what
is left before you hit a wall.

```
  /home/me/work/api        work 5h 95% 2h50m · wk 96% 6d5h · mo 48% 25d22h   18.4K (2%)  ctrl+p commands
```

`/use` opens a dashboard with every account, its plan, connection state, reset
countdowns and the last time each one refreshed:

```
  Usage  5 quota accounts · 1 without usage API  ·  updated 2s ago
  ────────────────────────────────────────────────────────────────
  ▸ work@example.com  OpenCode Console · Go
      connected · active · updated 2s ago · Personal · renews nov 7
      5-hour   ██████████ 95% left · resets in 2h 50m
      weekly   ██████████ 96% left · resets in 6d 5h
      monthly  █████░░░░░ 48% left · resets in 25d 22h

    personal@example.com  ChatGPT · Team
      connected · updated 1s ago
      5-hour   ██████░░░░ 61% left · resets in 4h 26m
      weekly   ████░░░░░░ 46% left · resets in 6d 4h

  other connected providers
    z.ai · zai · API key · no usage or balance API exposed
```

## why this exists

i run several accounts at once: a couple of chatgpt logins (the older codex
oauth ones) and two opencode console subscriptions. none of them are unlimited,
and i kept getting cut off mid-task because i had no idea how much of the 5 hour
window or the weekly window was left.

opencode shows what you have spent per session, but nothing that answers "how
much is left, on every account, right now". so i built this: one line in the
footer for the account i am actually using, and `/use` when i want the whole
picture. it reads the same usage data the providers themselves use, so the
numbers are real, never estimated.

## what it shows

| provider | where the numbers come from | windows |
| --- | --- | --- |
| opencode console (subscription) | `GET {server}/api/go/status` | 5 hour, weekly, monthly, from the meter's used/limit credit amounts |
| chatgpt (codex oauth accounts) | `GET https://chatgpt.com/backend-api/wham/usage` | 5 hour and weekly, from the provider's used percentage |

only windows a provider actually exposes are shown. accounts whose provider has
no usage api (api key providers such as z.ai) are listed as "no usage api"
instead of showing invented numbers. pay-as-you-go credit balances appear only
when the provider reports credits.

## install

opencode v2, terminal (tui) side. no build step, the plugin is typescript and
opencode loads it directly.

### 1. clone into the plugin directory (recommended)

```sh
git clone https://github.com/notsegun/opencode-quota \
  ~/.config/opencode/plugins/opencode-quota
```

opencode discovers plugins in that directory automatically. restart the tui and
the line appears under the prompt.

### 2. keep the checkout elsewhere and point opencode at it

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./vendor/opencode-quota"]
}
```

the path is relative to the config directory (`~/.config/opencode`). on opencode
2.0.27 an absolute path is resolved as if it were relative, so prefer the
relative form or the clone-into-plugins form above.

### 3. let your agent build it for you

if you would rather not clone anything, copy the prompt below into your agent
(claude code, codex, opencode itself, anything that can write files) and it will
recreate the plugin locally for your machine:

```text
build me an opencode v2 terminal plugin that shows my remaining subscription quota for every connected account.

context
- i have several accounts connected to opencode: chatgpt logins (the older codex oauth method) and opencode console subscriptions. none are unlimited, so i need to see what is left.
- opencode stores credentials in its own database and exposes them read only to plugins through the client api: context.client.credential.list() returns entries with { id, integrationID, label, active, value }, where value is { type: "oauth", access, refresh, expires, metadata }.
- write the plugin to ~/.config/opencode/plugins/opencode-quota/ as two files: tui.tsx (the plugin) and quota.ts (pure helpers). opencode discovers that directory automatically. imports of "@opencode/plugin/tui" and "solid-js" are resolved by opencode at runtime, so no package.json or node_modules is needed.

data sources (read only gets, never write credentials, never log or render tokens)
1. opencode console subscription, integration "opencode":
   GET {metadata.server}/api/go/status with headers authorization: bearer <access> and x-org-id: <metadata.orgID>.
   the response has access.meters.{fiveHour,week,month}, each with limitMicroCents and usedMicroCents (strings), and resetsAt (iso timestamp). remaining percent = (1 - used / limit) * 100. the response also has access.endsAt (renewal date) and access.cancelAtPeriodEnd.
2. chatgpt / codex accounts, integration "openai":
   GET https://chatgpt.com/backend-api/wham/usage with headers authorization: bearer <access>, chatgpt-account-id: <metadata.accountID> and a user agent of opencode/<version>.
   the response has plan_type, email, rate_limit.primary_window (5 hour) and rate_limit.secondary_window (weekly), each with used_percent, limit_window_seconds and reset_at (unix seconds), plus credits and rate_limit_reached_type.
   remaining percent = 100 - used_percent. never show used_percent as remaining.

footer line
- one line, appended to the "prompt.footer.status" slot so it sits in the footer row after the folder label and before opencode's tokens/cost/hints. never add a second row and never squeeze the built in content: when the terminal is narrower than 130 columns, drop the account label and keep only the windows.
- format: "<label> 5h <pct> <reset> · wk <pct> <reset> · mo <pct> <reset>", with " · " dividers. pct is the remaining percentage, reset is the time until that window resets (for example "2h50m", "6d5h"). a window that has not started shows "—".
- show only the account in use: the provider of the model selected in the prompt (falling back to the session's model, then the most recently used account). when i switch models the line must switch accounts immediately.
- mark the active credential with "▸", colour the percentages green, amber below 20% and red below 5%, and append an age suffix when the newest data is older than 30 seconds.
- labels: default to the email local part. when two accounts would render the same truncated name, fall back to the credential's stored label prefixed with a provider tag, for example "gpt·app" or "oc·work".

refreshing
- fetch the account in use about every 5 seconds, other connected accounts every 15 seconds, and accounts that need sign in every 60 seconds.
- refresh right after a request completes (subscribe to the "session.execution.succeeded" event and use the session's model provider), and force a refresh when the dashboard opens.
- deduplicate per account, cap concurrent requests at 2, time out after 8 seconds, and back off 10s doubling to a maximum of 1 minute on 429/5xx/network errors.
- keep every open tui in sync: share snapshots through context.storage.store("quota.shared", ...) which opencode syncs live between running tui instances. an instance claims an account before fetching and adopts any snapshot newer than its own, so one fetch serves every open pane and no two panes disagree.
- cache the last snapshot in plugin storage and restore it on start so the age shown is honest.

/use dashboard
- register "/use" as a native ui command with context.keymap.layer, using slash: { name: "use" } plus palette: true. it must not be an ai prompt and must not steer, queue or cancel anything.
- open it with context.ui.dialog.show and context.ui.dialog.set({ size: "xlarge", centered: true }). it has to work while the agent is generating.
- list every connected account: plan, connection state (connected, active, sign in required, no meters, no usage api), each window with a bar, the remaining percentage, the used percentage, the reset countdown, and the time since that account last refreshed.
- keys: r refresh, d toggle details, arrow keys and page up/down scroll, escape closes and returns to the session.

opencode v2 api gotchas i already hit, please respect them
- inside a <text> element, a <span> only takes colour through style={{ fg: color }}, not fg={color}.
- a component that returns <text> cannot be rendered inside another <text>; return a fragment of spans instead.
- context.storage.store(key, { initial }) returns a tuple [state, update], not an object.
- slots: "prompt.footer.status" shares one flex row with the folder label, tokens, cost and hints, so keep the line short; label sizing should follow renderer "resize" events.
- the theme in use may have fully transparent dialog backgrounds, which is normal for opencode's own dialogs.

verify before you say it works
1. the footer line renders with real percentages and ticking reset countdowns.
2. switching the model switches the account in the line.
3. /use opens while the agent is generating, without interrupting the run, and escape closes it.
4. values match the provider endpoints when checked directly.
5. run two tui instances at once and confirm they show the same numbers and the same data age.
```

## configuration

plugin options go in the same `plugins` entry, object form:

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/opencode-quota",
      "options": {
        "labels": { "cred_abc123": "work", "personal@example.com": "home" },
        "hidden": ["cred_def456"],
        "intervals": { "active": 5000, "connected": 15000, "idle": 60000 }
      }
    }
  ]
}
```

`labels` keys can be a credential id, `integration:credentialID`, an account
email, its local part, or the stored credential label.

## security

- credentials are read through opencode's own client (`credential.list`) and used only as bearer tokens for the two usage endpoints above.
- the plugin never writes, refreshes or switches credentials, and never touches model selection or agent behaviour.
- tokens are never rendered, logged or cached; the persisted snapshot holds labels, percentages, states and timestamps only.
- every request is a read-only `get` with an 8 second timeout.

## limitations

- both usage endpoints are provider-internal and can change. if a response shape changes, the account degrades to an honest "no meters" or error state rather than showing a wrong number.
- expired oauth tokens are reported as "sign in required"; the plugin does not refresh them, because that would write to your credentials. using the account in opencode refreshes it and the display recovers on its own.
- api key providers (z.ai, for example) expose no documented usage or balance endpoint, so only their connection state is listed.
- the footer line is hidden on the start screen, which uses a narrow centred composer where any extra text would squeeze the folder label.
- the 5 hour and weekly windows are what the providers expose; there is no monthly chatgpt window to show, and no percentage to invent.

## development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test, unit tests for the pure quota helpers
npm run check       # both
```

`quota.ts` holds the pure logic (percentage maths, window labels, countdown
formatting, label disambiguation, backoff) and has no opencode imports, which is
why it can be unit tested directly. `tui.tsx` holds the fetchers, the monitor,
the footer line and the dashboard. `index.ts` is the server entrypoint that makes
the package shape complete.
