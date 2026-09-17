# DESIGN BRIEF — Codex model catalogue and reasoning efforts (`codex-model-catalog`)

**Goal:** choose the models and efforts returned by the selected Codex account, with clear refresh and failure states.

**Design system:** reuse `PIPELINE.md` §design, the existing ModelPicker, ChipGroup, Button, modal and run-chip components. Native desktop app; use feature CSS and current tokens. No new mockup is required for this small refinement of existing controls.

## Screens / views

- **New Session / Session settings:** retain field ordering. The model field owns a compact refresh action and status line; efforts remain directly below/inside the selected model treatment.
- **Run chip:** retain the existing popover; Refresh models belongs beside its model-list heading. Do not move the permissions section or change its semantics.
- **Project defaults:** same model/effort field states, keyed to the project's chosen account.
- **Palette:** account-correct model choices and a refresh action using existing command-list interaction; no catalogue configuration screen.

States: initial loading, refreshing existing rows, success, successful empty, cached with warning, error without rows, unavailable saved selection.

## Flows

1. Opening a selector fetches its account's models. Keep an existing valid draft selection, otherwise runtime default then first row.
2. Switching accounts immediately removes old-account options. Announce loading after 150 ms; no animated skeleton.
3. **Refresh models** is a text/icon action with an accessible name. During same-account refresh keep rows visible, mark the action busy and avoid duplicate requests.
4. Success updates rows and default hints. Never write the underlying session or project just because options refreshed.
5. Failed refresh with usable cache: **Using cached models** plus refresh action and a concise safe error. Without cache: **Couldn't load models** and **Retry**. Empty success: **No models available** and Refresh models.
6. Preserve unavailable saved values as current-value text with **Not in the current catalogue**. They are not fabricated selectable rows. Saving unrelated changes remains possible; changing model/effort requires a supported choice.
7. **Model default** clears the explicit effort. If known, append its value as a muted hint, e.g. `Model default · low`. Every advertised effort gets its own choice, including `ultra` and future well-formed values.

## Responsive

- Desktop 720 px minimum through wide windows: preserve existing modal/run-chip widths, wrap effort chips and status copy; keep refresh keyboard-reachable at narrow widths.
- Model names may wrap inside existing list rows where allowed, with the full id available through the existing tooltip/accessibility treatment. No horizontal page overflow.
- No new mobile/tablet layout or breakpoints; this is the native desktop application.

## Data shown

- `ModelInfo.label`, optional brief, supported efforts and optional defaultEffort.
- The account heading already shown by the host field; never display a prior account's models underneath it.
- `ModelCatalog.freshness` drives cached-state copy. Do not expose RPC method names, cache keys, local paths, auth details or `legacy-adapter` in ordinary UI.
- A catalogue is what Codex returned, not a promise of entitlement. Do not label it verified against billing or invent context capacities.

## Notes / constraints

- English UI copy; existing field focus order, Escape dismissal, arrow/Enter navigation. Refresh is operable with Tab/Enter/Space; errors use the existing accessible status/error treatment.
- Use `--text-dim` / `--text-muted` for hints and existing error/attention tokens for failures. Accent remains the active selection; no new accent on refresh/cached labels.
- Reuse flat surfaces and current spacing. No new border, shadow, animation or icon system. Use the existing lucide refresh icon if an icon is needed; text supplies the accessible action name.
- Loading does not disable unrelated settings. Submit eligibility follows the spec's model/effort rules, not blanket form locking.
