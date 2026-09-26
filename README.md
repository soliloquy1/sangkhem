# sangkhem

A SillyTavern extension that runs small helper stages around your narrator model, instead of asking one model to remember and track everything on its own.

Each turn has two phases:

- **Plan**, before the narrator writes: **Memory** reads your Summaryception summary, **Lore** scores the World Info entries that matched and drops the low-value ones (using a local Laya model), and **Brief** adds short scene notes near the end of the prompt.
- **Observe**, after the reply is on screen: **Scene** asks a small model what changed (location, time, who is present and how they look, open plot threads). A change is only accepted if the model quotes the message that shows it.

Anything that fails or is missing is skipped. Replies always generate.

## Requirements

- SillyTavern 1.16 or newer.
- For scene tracking: a connection profile for a small or cheap model (Connection Manager).
- Optional: [Summaryception](https://github.com/Lodactio/Extension-Summaryception) for the Memory stage.
- Optional: the Laya service in `service/laya` for the Lore stage.

## Install

Extensions → Install extension → `https://github.com/soliloquy1/sangkhem`

## Set up

1. Extensions → sangkhem → Settings → Scene tracking: pick a connection profile.
2. Optional: start the Laya service (`service/laya/README.md`) and press **Test connection**.
3. If you use Laya WI Director, turn off its **Enable** (sangkhem's Lore stage replaces it; its reply guard can stay on).

The Stages list shows what is ready and what each stage needs.

## Using it

- The **Scene** section shows the current state. Edit and save to correct it; your edit wins until new evidence changes it. "Where these came from" links each fact to the message it was quoted from.
- If an extraction fails, the Scene section shows **Out of date** with a **Retry** button. It is not retried automatically; Retry, editing the message, or a new reply tries again.
- The **Last turn** section shows what each stage did and how long it took, plus session timings.
- `/conductor on|off|status`, `/scene`, `/scene set location=rooftop`, `/scene set present.Ellen.outfit=red coat`.
- Put `{{conductor_brief}}` in your preset and set Brief placement to macro mode to place the notes yourself.

## With other extensions

| Extension | What sangkhem does |
|---|---|
| Summaryception | Reads its summary; never injects it again. |
| SnapCompact | Leaves it alone. Lore entries the Lore stage drops are disabled before ST's real scan, so SnapCompact never receives or images them. |
| Laya WI Director | Replaces its lore pruning (turn that off); its reply guard keeps working. |
| Recast | Leaves it alone; scene tracking reads the rewritten reply. |
| CoT Guard, reasoning | Scene tracking ignores CoT blocks and skips replies that get auto-swiped. |

## Development

    npm test
    node tools/eval-scene.mjs --url <OpenAI-compatible URL> --model <id>

Design: `docs/superpowers/specs/2026-09-25-conductor-design.md`.
