---
id: codex-interactive-session
title: "04 · Sessions Codex interactives"
status: draft
branch: feat/codex-interactive-session
created: 2026-09-17
depends_on: [provider-effective-capabilities]
reviewed_base:
reviewed_digest:
design_files: []
---

# 04 · Sessions Codex interactives

> Draft de découpage — non dispatchable. Les critères ci-dessous fixent la cible, pas un contrat gelé.
> Programme : [provider-capability-parity](provider-capability-parity.md), phase 2.
> Ordre choisi sur délégation utilisateur du 2026-09-17 ; un ticket Obsidian porte exactement cet identifiant.

## 1. Summary

Intégrer le transport interactif Codex pour les tours, événements, demandes utilisateur et interruptions.

## 2. Goals & non-goals

- App Server par compte, cycle de vie borné et séparation des threads.
- Traduire texte/outils, questions, approbations, décisions et annulation.
- Reprendre les sessions existantes créées avec exec sans perdre leur continuité.

La cible globale reste celle du programme ; les capacités des lots voisins n'en sont pas exclues. Aucun nouveau provider ni parité de qualité des modèles. Découper encore avant gel si le contrat dépasse environ 300 lignes, en créant les tickets correspondants.

## 3. User stories / flows

À détailler au gel dans les vues existantes, souris et clavier inclus. L'action affichée doit produire un effet vérifié dans le bon moteur, compte et modèle.

## 4. Functional requirements

Les exigences FR numérotées seront dérivées des preuves et des critères §9. Aucun payload ou contrôle natif ne doit être inventé pour combler une preuve manquante.

## 5. API contract

Contrats existants à étendre en place : `contract/multi-provider-codex.ts`, `contract/session-engine.ts`, `contract/session-questions.ts`, `contract/permission-guardrails.ts`. Types, canaux, validation et erreurs exacts restent à figer après les points ci-dessous. Pas de deuxième contrat propriétaire d'un domaine existant.

- [ ] Capturer approbations/questions et reprise d'un thread exec authentifié.
- [ ] Figer binding des modes de permission et gestion des événements rejoués.

## 6. Data & state

Définir sources d'autorité, fraîcheur, propriété, invalidation et persistance au gel. Garder compte/moteur/protocole distincts et les fils natifs séparés des transcripts rendus. Les implémenteurs ne doivent pas déduire ces décisions de ce draft.

## 7. Edge cases & errors

Documenter au gel les cas absents/partiels, erreurs natives, déconnexion, changement de compte et reprise. Une capacité non vérifiée reste à investiguer, jamais « impossible » par défaut.

## 8. Design brief

Vues existantes, mêmes interactions pour les capacités communes ; limitations au point d'usage. Le brief complet sera écrit dans `specs/design/codex-interactive-session.md` au gel si le lot modifie l'UI.

## 9. Acceptance criteria

- [ ] Une demande réelle reçoit la réponse de l'utilisateur dans le moteur.
- [ ] Arrêt et perte du transport résolvent les demandes en cours sans doublons.
- [ ] Une session existante peut reprendre, ou son incompatibilité est expliquée sans perte silencieuse.
- [ ] Les payloads/contrôles nécessaires sont étayés par code, documentation officielle et captures réelles lorsque requis.
- [ ] Les régressions sur shell, git/diff, worktrees, layout, notifications et continuité liées aux événements modifiés sont couvertes.
- [ ] §5 complet, brief applicable et tests d'acceptation définis avant passage à frozen/Ready to build.

## Remediation

(Vide ; aucune revue.)
