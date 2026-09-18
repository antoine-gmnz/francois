---
id: grok-interactive-session
title: "05 · Sessions Grok interactives"
status: draft
branch: feat/grok-interactive-session
created: 2026-09-17
depends_on: [provider-effective-capabilities]
reviewed_base:
reviewed_digest:
design_files: []
---

# 05 · Sessions Grok interactives

> Draft de découpage — non dispatchable. Les critères ci-dessous fixent la cible, pas un contrat gelé.
> Programme : [provider-capability-parity](provider-capability-parity.md), phase 2.
> Ordre choisi sur délégation utilisateur du 2026-09-17 ; un ticket Obsidian porte exactement cet identifiant.

## 1. Summary

Exploiter ACP pour les interactions Grok que le mode headless actuel ne peut pas porter.

## 2. Goals & non-goals

- Capturer puis intégrer grok agent stdio sur une version cible.
- Relier texte/outils, demandes de permission, questions et annulation aux vues communes.
- Préserver compte, sandbox/OS et reprise des sessions existantes.

La cible globale reste celle du programme ; les capacités des lots voisins n'en sont pas exclues. Aucun nouveau provider ni parité de qualité des modèles. Découper encore avant gel si le contrat dépasse environ 300 lignes, en créant les tickets correspondants.

## 3. User stories / flows

À détailler au gel dans les vues existantes, souris et clavier inclus. L'action affichée doit produire un effet vérifié dans le bon moteur, compte et modèle.

## 4. Functional requirements

Les exigences FR numérotées seront dérivées des preuves et des critères §9. Aucun payload ou contrôle natif ne doit être inventé pour combler une preuve manquante.

## 5. API contract

Contrats existants à étendre en place : `contract/multi-provider-grok.ts`, `contract/session-engine.ts`, `contract/session-questions.ts`, `contract/permission-guardrails.ts`. Types, canaux, validation et erreurs exacts restent à figer après les points ci-dessous. Pas de deuxième contrat propriétaire d'un domaine existant.

- [ ] CLI absent de cet environnement : obtenir une capture authentifiée avant gel.
- [ ] Établir les méthodes supportées, la reprise et la correspondance des modes.

## 6. Data & state

Définir sources d'autorité, fraîcheur, propriété, invalidation et persistance au gel. Garder compte/moteur/protocole distincts et les fils natifs séparés des transcripts rendus. Les implémenteurs ne doivent pas déduire ces décisions de ce draft.

## 7. Edge cases & errors

Documenter au gel les cas absents/partiels, erreurs natives, déconnexion, changement de compte et reprise. Une capacité non vérifiée reste à investiguer, jamais « impossible » par défaut.

## 8. Design brief

Vues existantes, mêmes interactions pour les capacités communes ; limitations au point d'usage. Le brief complet sera écrit dans `specs/design/grok-interactive-session.md` au gel si le lot modifie l'UI.

## 9. Acceptance criteria

- [ ] Les payloads implémentés correspondent à des captures réelles versionnées.
- [ ] Les réponses et refus sont appliqués par Grok, pas seulement dans l'UI.
- [ ] Chaque garantie dépendante de l'OS est correctement annoncée.
- [ ] Les payloads/contrôles nécessaires sont étayés par code, documentation officielle et captures réelles lorsque requis.
- [ ] Les régressions sur shell, git/diff, worktrees, layout, notifications et continuité liées aux événements modifiés sont couvertes.
- [ ] §5 complet, brief applicable et tests d'acceptation définis avant passage à frozen/Ready to build.

## Remediation

(Vide ; aucune revue.)
