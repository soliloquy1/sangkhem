# Manual test checklist

Run in a real SillyTavern with sangkhem symlinked into `data/default-user/extensions/`. Keep the browser console open; any `[sangkhem]` error is a failure.

## Setups

- [ ] Vanilla: no Summaryception, no Laya service, no scene profile. Replies generate normally; Stages shows memory/lore/scene unavailable with reasons; brief shows "no scene state yet".
- [ ] Full: Summaryception on, Laya service running, scene profile chosen.

## Generation types (full setup)

- [ ] Normal: reply arrives; about 1.5 s later the Scene section updates; inspector shows memory/lore/brief ran.
- [ ] Swipe: new swipe gets its own state; swiping back restores the earlier swipe's state.
- [ ] Regenerate: brief for the new reply uses the state from before the replaced message.
- [ ] Continue: no new plan in the inspector; the continued message is re-observed.
- [ ] Impersonate: plan runs; nothing is observed.
- [ ] Edit the AI message: scene re-observes. Edit the user message before it: the reply re-observes.
- [ ] Delete the last AI message: Scene falls back to the previous message's state.
- [ ] Branch from a message: the branch shows the state at that message.
- [ ] Stop a generation mid-plan: no error, next send works.
- [ ] Switch chats while a reply is being observed: nothing is written into the other chat.
- [ ] Group chat (two characters reply in a row): the second reply's scene includes changes from the first.
- [ ] Commit mode (Settings → Observe → when I send my next message): after a group turn, both replies are observed in order before the next plan.
- [ ] Edit a scene field while "Updating…" is shown and save: your edit is still there after the extraction finishes.
- [ ] Start editing the scene, switch chats, switch back: the draft is gone and nothing was saved into the other chat.

## Other extensions

- [ ] Recast on: the scene reflects the rewritten text (check the inspector's evidence quotes).
- [ ] CoT Guard auto-swipes: rejected replies are not observed (no scene call for them in the inspector).
- [ ] Laya WI Director enabled: Lore shows the conflict reason and does not run; turning it off makes Lore ready.
- [ ] Summaryception quiet summarisation runs: no extra plan appears in the inspector for it.

## Failure paths

- [ ] Stop the Laya service mid-session: Lore shows "unreachable" and replies still generate.
- [ ] Point the Lore service URL at an address that never answers and press Test connection: it reports failure within about 3 s.
- [ ] Slow scene model with a small plan budget: the brief is still injected (inspector shows brief ran).
- [ ] Pick a scene profile whose API key is wrong: after 3 replies one warning toast appears; Scene shows "Out of date" with Retry.
- [ ] Put `<b>x</b>` in a scene field and save: it displays literally.

## Brief placement

- [ ] Prompt itemization shows `<scene_notes>` just before the latest user message.
- [ ] Macro mode + `{{conductor_brief}}` in the preset: notes appear where placed and only once.

## Success-criteria A/B (spec)

- [ ] Two cards, 50 turns each with sangkhem off and on. Count continuity errors (wrong location, outfit/condition, presence, forgotten thread). Record counts and the inspector's session p50/p95 and token numbers in `docs/ab-results.md`.
