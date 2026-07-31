# channel-reply-guard — Stop hook

## Problem

A Marveen agent that talks to a user over a channel (Telegram / Slack / Discord)
sometimes *generates* its reply as plain text but forgets to call the channel
send-tool. When that happens the answer only lands in the CLI transcript and
**never reaches the user** — the user is left waiting, with no idea whether the
agent is working or stuck.

## What the hook does

`scripts/channel-reply-guard.sh` runs on the `Stop` event. At the end of every
turn it checks:

1. Did the **last user message come from a channel**? (It looks for the
   `<channel source="plugin:telegram...">` / `← telegram` markers.)
2. If so, was there a **channel send-tool call** after that message?
   (Any tool whose name contains `telegram`, `reply`, `slack`, or `discord`.)

If the message was from a channel but **no send-tool was called**, the hook
returns `{"decision":"block"}` with a reminder, so the model sends the reply
before the turn ends.

Heartbeat / scheduled-task prompts (where staying silent is correct) are
explicitly skipped — they may end without a send.

## How to enable it

Add it to the `Stop` hooks in your `.claude/settings.json` (alongside any
existing Stop hooks):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/scripts/channel-reply-guard.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

(Use an absolute path if `${CLAUDE_PROJECT_DIR}` is not available in your setup.)

After editing `settings.json`, open the `/hooks` menu once (or restart the
session) so the hook is picked up.

## DEAD-time safety net (channel_outbox)

The block above covers the case where the model *forgot* to call the send-tool.
A second gap remains: the model **did** call the reply tool, but the channel
plugin was DEAD (crashed / mid-respawn), so the reply was lost with no retry.

When the hook sees a reply tool call, it POSTs the reply (`chat_id`, `text`,
`format`) to `POST /api/channel/send`. That endpoint is the **dedup gate**: it
enqueues the message into `channel_outbox` **only when the plugin is DEAD at
that moment**. A reply that already went out while the plugin was HEALTHY is
declined (no-op), so a queued row can never duplicate a delivered reply — the
at-most-once guarantee lives in the endpoint, not this hook. A 20 s drain
(`src/channel-outbox.ts`) flushes queued rows via the direct Bot API once the
plugin is HEALTHY again (max 3 transient retries, 5 min TTL, then drop + log).

The enqueue path is **best-effort and fully fail-safe**: any error (endpoint
down, no token, parse failure) is swallowed and never affects the block decision
or the turn. So if the hook itself dies, the safety net simply goes silent —
messages are lost as before, but nothing is ever duplicated.

### Hook liveness

Because the safety net depends on the stop-hook actually firing, every run
touches `store/.reply-guard-last-run`. A monitor can compare that stamp's age
against channel activity: if traffic is flowing but the stamp is stale, the hook
has silently died (see the fleet's history of hook drop-outs) and should be
re-registered. The script is version-controlled under `scripts/`, so a deploy
that tracks it prevents the untracked-hook fragility class.

## Relation to #210

PR #210 stops sub-agents from stealing the Telegram poller and lets heartbeats
answer direct messages — it protects the *inbound* path. This hook protects the
*outbound* path: it guarantees the agent's reply actually leaves through the
channel. The two are complementary.
