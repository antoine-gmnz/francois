---
id: patch-sidebar-collapse
kind: patch
status: shipped
reviewed_base: 5784c98d68bae604fd08731b2a34173094cb2168
reviewed_digest: 21cb70301a338ea0
surfaces: [frontend]
---

# Sidebar collapse button

## 1. Symptom / reproduction
Open the sidebar with the bottom-left rail button, then click its footer collapse button.
The sidebar remains open.

## 2. Expected behavior
The footer button collapses the sidebar to the session rail.

## 3. Cause and scope
Sidebar.tsx's footer click bubbles to the section's focus handler.
setFocusedPane('sidebar') reveals the sidebar immediately after toggleLeftPane hides it.
Stop the collapse click propagation before toggling. Frontend only.

## 4. Regression verification
Existing src/lib/layoutStore.test.ts and src/app/appShell.test.ts exercise layout state
and shell column rules. Review the actual event path: the footer click must stop propagation
before toggling, while ordinary roster clicks continue to focus the sidebar.
Native desktop click verification remains a manual follow-up; no desktop proof is claimed.

## 5. Contract delta
None.

## 7. Out of scope
No changes to sidebar layout, shortcuts, session selection, or backend.

## 9. Acceptance criteria / DoD
- [x] Collapse clicks cannot reach the roster's focus click handler.
- [x] The rail expand button and ordinary roster focus behavior are preserved.
- [x] Frontend build, tests and lint pass.
