---
id: provider-settings-parity
title: "12 · Réglages, profils et commandes effectifs"
status: draft
branch: feat/provider-settings-parity
created: 2026-09-17
depends_on: [provider-model-catalogs, codex-interactive-session, grok-interactive-session, capability-registry]
reviewed_base:
reviewed_digest:
design_files: []
---

# 12 · Réglages, profils et commandes effectifs

> Draft de découpage — non dispatchable. Les critères ci-dessous fixent la cible, pas un contrat gelé.
> Programme : [provider-capability-parity](provider-capability-parity.md), phase 4.
> Ordre choisi sur délégation utilisateur du 2026-09-17 ; un ticket Obsidian porte exactement cet identifiant.

## 1. Summary

Garantir qu'un réglage présenté et accepté est effectivement appliqué par le moteur concerné.

## 2. Goals & non-goals

- Profils, prompt système, instructions de réponse et réglages spécifiques réellement transmis.
- Actions slash/palette par runtime, sans lancer Claude derrière une session d'un autre moteur.
- Service tiers/modalités/réglages disponibles selon preuves ; aucune traduction aveugle d'argv.

La cible globale reste celle du programme ; les capacités des lots voisins n'en sont pas exclues. Aucun nouveau provider ni parité de qualité des modèles. Découper encore avant gel si le contrat dépasse environ 300 lignes, en créant les tickets correspondants.

## 3. User stories / flows

À détailler au gel dans les vues existantes, souris et clavier inclus. L'action affichée doit produire un effet vérifié dans le bon moteur, compte et modèle.

## 4. Functional requirements

Les exigences FR numérotées seront dérivées des preuves et des critères §9. Aucun payload ou contrôle natif ne doit être inventé pour combler une preuve manquante.

## 5. API contract

Contrats existants à étendre en place : `contract/session-settings-sheet.ts`, `contract/session-profiles.ts`, `contract/interactive-commands.ts`, `contract/slash-menu.ts`, `contract/response-mode.ts`. Types, canaux, validation et erreurs exacts restent à figer après les points ci-dessous. Pas de deuxième contrat propriétaire d'un domaine existant.

- [ ] Inventorier les derniers chemins directs vers Claude.
- [ ] Figer ports de profils et service tiers à partir des possibilités documentées/capturées.

## 6. Data & state

Définir sources d'autorité, fraîcheur, propriété, invalidation et persistance au gel. Garder compte/moteur/protocole distincts et les fils natifs séparés des transcripts rendus. Les implémenteurs ne doivent pas déduire ces décisions de ce draft.

## 7. Edge cases & errors

Documenter au gel les cas absents/partiels, erreurs natives, déconnexion, changement de compte et reprise. Une capacité non vérifiée reste à investiguer, jamais « impossible » par défaut.

## 8. Design brief

Vues existantes, mêmes interactions pour les capacités communes ; limitations au point d'usage. Le brief complet sera écrit dans `specs/design/provider-settings-parity.md` au gel si le lot modifie l'UI.

## 9. Acceptance criteria

- [ ] Chaque réglage indique son moment d'effet et atteint le bon moteur.
- [ ] Un réglage non applicable a une raison ; il n'est pas accepté puis ignoré.
- [ ] Les commandes communes atteignent l'adaptateur correct, les commandes spécifiques sont identifiées.
- [ ] Les payloads/contrôles nécessaires sont étayés par code, documentation officielle et captures réelles lorsque requis.
- [ ] Les régressions sur shell, git/diff, worktrees, layout, notifications et continuité liées aux événements modifiés sont couvertes.
- [ ] §5 complet, brief applicable et tests d'acceptation définis avant passage à frozen/Ready to build.

## Remediation

(Vide ; aucune revue.)
