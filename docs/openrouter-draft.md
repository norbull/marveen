# OpenRouter free-layer draft tool

A **PLUS** draft tool next to Nyx (local Qwen2.5-Coder on the GPU) and Codex.
It calls a cheap external model on [OpenRouter](https://openrouter.ai) and
prints a **DRAFT** that a Claude agent must review before anything ships. It
does **not** replace Nyx or Codex, and no default workflow routes to it. This is
a **Dex-only pilot** (kanban b38aa670).

## Where it sits

```
Nyx (local Qwen, free, first stop) ── offline draft, private
Codex (ChatGPT Plus quota)         ── bigger multi-step, edits a workspace
openrouter-draft (this)            ── cloud free model when local is too weak
                                      or Ollama is down; PLUS tool, opt-in
```

Same contract as `scripts/local-codegen.py`: draft to **stdout**, meta to
**stderr**, non-zero exit on failure so the caller falls back to Claude.

## Files

| File | Role |
|---|---|
| `scripts/openrouter-draft.sh` | Thin wrapper (prompt from file / arg / stdin), mirrors `nyx-draft.sh`. |
| `scripts/openrouter-draft.py` | Helper: resolves the alias, calls OpenRouter, strips fences, retries once. |
| `seed-config/openrouter-models.json` | Alias table. `store/openrouter-models.json` overrides it if present. |
| `store/.openrouter-api-key` | API key, mode `0600`, git-ignored. `OPENROUTER_API_KEY` env overrides. |

## Usage

```bash
scripts/openrouter-draft.sh "Write a function that ..."   # literal prompt
scripts/openrouter-draft.sh prompt.txt                    # prompt from a file
echo "prompt" | scripts/openrouter-draft.sh               # stdin
scripts/openrouter-draft.sh --model dex_code_fallback prompt.txt
scripts/openrouter-draft.sh --list                        # print alias table, exit
scripts/openrouter-draft.sh --temp 0.3 --timeout 60 prompt.txt
```

`--model` accepts an **alias** (resolved from the table) or a full
`vendor/model:free` id. Default alias: `dex_code_primary`.

## Alias table (pilot defaults)

| Alias | Model | Intended use |
|---|---|---|
| `dex_code_primary` | `poolside/laguna-xs-2.1:free` | Dex coding draft, review, tests |
| `dex_code_fallback` | `cohere/north-mini-code:free` | Fallback / independent check |
| `orin_nova_critic` | `nvidia/nemotron-3-ultra-550b-a55b:free` | Parallel critique, long-context second opinion |
| `atlas_iris_general` | `qwen/qwen3-next-80b-a3b-instruct:free` | Synthesis, variations, structured JSON |
| `general_fallback` | `meta-llama/llama-3.3-70b-instruct:free` | Rewrite, simple synthesis |
| `utility` | `nvidia/nemotron-3-nano-30b-a3b:free` | Labeling, bulk pre-processing |
| `safety` | `nvidia/nemotron-3.5-content-safety:free` | Optional moderation gate |

`:free` endpoints get deprecated or rate-limited. Before trusting an alias
long-term, re-check it against the Models API:
`curl https://openrouter.ai/api/v1/models`.

## Limits and safety

- **Rate limit is FLEET-wide, not per-agent**: 20 req/min and 50 req/day under
  10 USD credit (1000/day after buying ≥10 USD credit). The tool does not
  throttle -- a 429 just exits non-zero and the caller falls back to Claude.
- **Never send secrets, tokens, `.env` or private repo contents.** The prompt
  goes to an external provider. Give it a minimal, task-specific prompt, not the
  whole repo. (The permission-router HTTP-egress gate allowlists `openrouter.ai`,
  so the call itself is routine, but that does not sanitize the payload -- that
  is on the caller.)
- The draft is **never final**. The local 7B and the free cloud models both make
  correctness mistakes; treat every output as a draft to review. See the
  `local-draft-codegen` skill for the review checklist.

> **Gotcha (permission-router interaction).** Writing the literal word `curl` or
> `wget` in a commit message, an inter-agent status report, or any Bash command
> line *without* a literal URL trips the HTTP-egress gate's fail-secure branch --
> it looks like a fetch to an unknown host. Send such text from a file
> (`git commit -F file`, or read the message from a file into the request body)
> so the word never sits on the command line. This is expected fail-secure
> behavior, not a bug.

## Failure modes

| Exit | Meaning |
|---|---|
| 0 | Draft printed to stdout. |
| 1 | HTTP / timeout / unexpected response after one retry -> fall back to Claude. |
| 2 | Bad usage: empty prompt, unknown alias, unreadable alias table. |
| 3 | No API key (set `OPENROUTER_API_KEY` or write `store/.openrouter-api-key`). |
