---
id: provider-input-parity
title: "15 · Pièces jointes et entrées multimodales"
status: draft
branch: feat/provider-input-parity
created: 2026-09-17
depends_on: [provider-model-catalogs, codex-interactive-session, grok-interactive-session]
reviewed_base:
reviewed_digest:
design_files: []
---

# 15 · Pièces jointes et entrées multimodales

> Draft de découpage — non dispatchable. Les critères ci-dessous fixent la cible, pas un contrat gelé.
> Programme : [provider-capability-parity](provider-capability-parity.md), phase 4.
> Ordre choisi sur délégation utilisateur du 2026-09-17 ; un ticket Obsidian porte exactement cet identifiant.

## 1. Summary

Acheminer réellement fichiers et images vers les modèles qui les acceptent.

## 2. Goals & non-goals

- Distinguer fichier stocké, référence textuelle, lecture par outil et entrée multimodale native.
- Respecter capacités par modèle, limites, erreurs et permissions.
- Préserver références et contenu utile à la reprise.

La cible globale reste celle du programme ; les capacités des lots voisins n'en sont pas exclues. Aucun nouveau provider ni parité de qualité des modèles. Découper encore avant gel si le contrat dépasse environ 300 lignes, en créant les tickets correspondants.

## 3. User stories / flows

À détailler au gel dans les vues existantes, souris et clavier inclus. L'action affichée doit produire un effet vérifié dans le bon moteur, compte et modèle.

## 4. Functional requirements

Les exigences FR numérotées seront dérivées des preuves et des critères §9. Aucun payload ou contrôle natif ne doit être inventé pour combler une preuve manquante.

## 5. API contract

Contrats existants à étendre en place : `contract/session-attachments.ts`, `contract/session-engine.ts`, `contract/common.ts`, `contract/multi-provider-openai.ts`. Types, canaux, validation et erreurs exacts restent à figer après les points ci-dessous. Pas de deuxième contrat propriétaire d'un domaine existant.

- [ ] Figer formats/tailles supportés par chaque transport et endpoint.
- [ ] Définir dégradations explicites et politique de conservation sans fuite intercompte.

## 6. Data & state

Définir sources d'autorité, fraîcheur, propriété, invalidation et persistance au gel. Garder compte/moteur/protocole distincts et les fils natifs séparés des transcripts rendus. Les implémenteurs ne doivent pas déduire ces décisions de ce draft.

## 7. Edge cases & errors

Documenter au gel les cas absents/partiels, erreurs natives, déconnexion, changement de compte et reprise. Une capacité non vérifiée reste à investiguer, jamais « impossible » par défaut.

## 8. Design brief

Vues existantes, mêmes interactions pour les capacités communes ; limitations au point d'usage. Le brief complet sera écrit dans `specs/design/provider-input-parity.md` au gel si le lot modifie l'UI.

## 9. Acceptance criteria

- [ ] Une image n'est pas annoncée comme reçue par le modèle quand seul son chemin a été envoyé.
- [ ] Entrée non supportée reçoit une explication précise.
- [ ] Les captures attestent l'acheminement et la reprise sur les chemins disponibles.
- [ ] Les payloads/contrôles nécessaires sont étayés par code, documentation officielle et captures réelles lorsque requis.
- [ ] Les régressions sur shell, git/diff, worktrees, layout, notifications et continuité liées aux événements modifiés sont couvertes.
- [ ] §5 complet, brief applicable et tests d'acceptation définis avant passage à frozen/Ready to build.

## Remediation

(Vide ; aucune revue.)
