# tianshu-mcp v0.3.3 Release Notes

v0.3.3 fixes issues #4 / #7. ZCode 3.11.2 changed model-menu provider groups to family groups and changed the effective project-binding entry point and read-back signal. This release also closes acceptance false positives caused by zero executed tests or zero file changes.

## ZCode 3.11.2 model selection

- Provider groups support both `chat-model-select-group-provider:` and `chat-model-select-group-family:`.
- After opening the menu, the adapter first selects the visible flat model directly. Only a miss triggers provider/family expansion and a second model attempt, covering both new and legacy layouts.
- `model_unavailable` and permission-selection failures now include visible text and `data-testid` candidates for CDP diagnosis of future selector drift.

## Project import and binding

- New-project import dismisses a stale workspace menu before opening Add Project and retries the bounded dismiss/click/verify sequence up to three times, handling a consumed first outside click.
- Binding prioritizes the composer's `menuitemcheckbox`, uniquely matched by the normalized directory display name; the legacy sidebar item remains a fallback.
- Binding read-back now includes the composer trigger text and rejects localized unbound placeholders. A failed bind is retried idempotently for up to two rounds.

## Discovery paths and acceptance

- ZCode/TraeWork Program Files placeholders are consistently uppercase. Placeholder expansion is case-insensitive and preserves unknown values.
- A test check fails when its output explicitly reports zero tests, even if the process exits with code 0.
- Git projects require a change from the pre-work baseline by default. Pure analysis tasks can opt out with `"requireChanges": false` in `.tianshu-mcp/acceptance.json`.

## Compatibility and verification

- Legacy ZCode provider-group layouts and sidebar project entries remain supported as fallbacks; the full-path read-back fast path remains available.
- Windows and macOS code paths contain no hardcoded user directories.
- Automated regression coverage includes both model-menu layouts, project import/binding retries, and both fail-closed gates.
