---
id: provider-agent-control
title: "07 · Sous-agents : exécution, messages et arrêt réel"
status: draft
branch: feat/provider-agent-control
created: 2026-09-17
depends_on: [provider-agent-observation]
reviewed_base:
reviewed_digest:
design_files: []
---

# 07 · Sous-agents : exécution, messages et arrêt réel

> Draft de découpage — non dispatchable. Les critères ci-dessous fixent la cible, pas un contrat gelé.
> Programme : [provider-capability-parity](provider-capability-parity.md), phase 2.
> Ordre choisi sur délégation utilisateur du 2026-09-17 ; un ticket Obsidian porte exactement cet identifiant.

## 1. Summary

Rendre effectifs le dispatch, les messages, la relance et l'arrêt ciblé, y compris via un dispatcher François.

## 2. Goals & non-goals

- Remplacer les mutations purement locales du panneau Claude.
- Relier les contrôles natifs vérifiés sans interrompre le parent par erreur.
- Fournir à la boucle François des enfants réels avec permissions et reprise ; séparer message et nouvelle tâche.

La cible globale reste celle du programme ; les capacités des lots voisins n'en sont pas exclues. Aucun nouveau provider ni parité de qualité des modèles. Découper encore avant gel si le contrat dépasse environ 300 lignes, en créant les tickets correspondants.

## 3. User stories / flows

À détailler au gel dans les vues existantes, souris et clavier inclus. L'action affichée doit produire un effet vérifié dans le bon moteur, compte et modèle.

## 4. Functional requirements

Les exigences FR numérotées seront dérivées des preuves et des critères §9. Aucun payload ou contrôle natif ne doit être inventé pour combler une preuve manquante.

## 5. API contract

Contrats existants à étendre en place : `contract/agents-panel.ts`, `contract/async-agents.ts`, `contract/agent-tab.ts`, `contract/common.ts`, `contract/multi-provider-openai.ts`. Types, canaux, validation et erreurs exacts restent à figer après les points ci-dessous. Pas de deuxième contrat propriétaire d'un domaine existant.

- [ ] Prouver les RPC/contrôles enfants réels ; un nom d'outil collab n'est pas une API cliente.
- [ ] Fixer idempotence, limites d'enfants, héritage et reprise du dispatcher.

## 6. Data & state

Définir sources d'autorité, fraîcheur, propriété, invalidation et persistance au gel. Garder compte/moteur/protocole distincts et les fils natifs séparés des transcripts rendus. Les implémenteurs ne doivent pas déduire ces décisions de ce draft.

## 7. Edge cases & errors

Documenter au gel les cas absents/partiels, erreurs natives, déconnexion, changement de compte et reprise. Une capacité non vérifiée reste à investiguer, jamais « impossible » par défaut.

## 8. Design brief

Vues existantes, mêmes interactions pour les capacités communes ; limitations au point d'usage. Le brief complet sera écrit dans `specs/design/provider-agent-control.md` au gel si le lot modifie l'UI.

## 9. Acceptance criteria

- [ ] Un dispatch réussi démarre du travail réel et en fournit l'identité.
- [ ] Un arrêt confirmé cesse le travail ciblé ; aucun arrêt local fictif.
- [ ] Les enfants François respectent l'isolation de compte, permissions et annulation.
- [ ] Les payloads/contrôles nécessaires sont étayés par code, documentation officielle et captures réelles lorsque requis.
- [ ] Les régressions sur shell, git/diff, worktrees, layout, notifications et continuité liées aux événements modifiés sont couvertes.
- [ ] §5 complet, brief applicable et tests d'acceptation définis avant passage à frozen/Ready to build.

## Remediation

(Vide ; aucune revue.)
