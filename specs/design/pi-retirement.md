# Pi retirement — existing design reuse

Source: repository Francois Redesign.dc.html, Claude Terminal.dc.html, existing ResumeFailBanner/UsageLimitBanner/EmptyPane and account/profile/transcript components. This is removal and reuse, not a new design.

- Existing Pi transcript uses current layout/scrolling; static notice says **Pi is unavailable in this version. Saved history is read-only.** No Retry/Create new session/reconnect/Send controls.
- Pi account/profile rows remain labelled **Unavailable** and cannot execute or mutate. Saved defaults stay visible until explicit available selection.
- Remove Pi setup/installation/policy/model/migration fields. Surviving controls retain spacing/tokens/keyboard interactions/breakpoints.
- Permission/question cards and roster approvals are inert, including persisted pending cards. No action may execute while rendering or viewing history.
- Existing empty treatment covers missing local projection; no native history read is triggered.
- Use existing UI primitives, per-feature CSS and English copy; preserve shared accessibility and status-class improvements.
