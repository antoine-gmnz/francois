---
id: provider-effective-capabilities
title: "03 · Capacités effectives par action"
status: draft
branch: feat/provider-effective-capabilities
created: 2026-09-17
depends_on: [codex-model-catalog]
reviewed_base:
reviewed_digest:
design_files: []
---

# 03 · Capacités effectives par action

> Draft de découpage — non dispatchable. Les critères ci-dessous fixent la cible, pas un contrat gelé.
> Programme : [provider-capability-parity](provider-capability-parity.md), phase 1.
> Ordre choisi sur délégation utilisateur du 2026-09-17 ; un ticket Obsidian porte exactement cet identifiant.

## 1. Summary

Remplacer les booléens globaux trompeurs par les opérations effectivement disponibles au point d'usage.

## 2. Goals & non-goals

- Distinguer observer, créer, envoyer un message, arrêter, installer et reconnecter.
- Calculer selon moteur, compte, modèle, version et état opérationnel.
- Protéger les points d'entrée core et présenter les raisons au point d'usage.

La cible globale reste celle du programme ; les capacités des lots voisins n'en sont pas exclues. Aucun nouveau provider ni parité de qualité des modèles. Découper encore avant gel si le contrat dépasse environ 300 lignes, en créant les tickets correspondants.

## 3. User stories / flows

À détailler au gel dans les vues existantes, souris et clavier inclus. L'action affichée doit produire un effet vérifié dans le bon moteur, compte et modèle.

## 4. Functional requirements

Les exigences FR numérotées seront dérivées des preuves et des critères §9. Aucun payload ou contrôle natif ne doit être inventé pour combler une preuve manquante.

## 5. API contract

Contrats existants à étendre en place : `contract/multi-provider-seam.ts`, `contract/common.ts`, `contract/session-engine.ts`. Types, canaux, validation et erreurs exacts restent à figer après les points ci-dessous. Pas de deuxième contrat propriétaire d'un domaine existant.

- [ ] Figer le vocabulaire des actions et les erreurs après recensement des call sites.
- [ ] Définir snapshot/invalidation et transport dans le domaine existant.

## 6. Data & state

Définir sources d'autorité, fraîcheur, propriété, invalidation et persistance au gel. Garder compte/moteur/protocole distincts et les fils natifs séparés des transcripts rendus. Les implémenteurs ne doivent pas déduire ces décisions de ce draft.

## 7. Edge cases & errors

Documenter au gel les cas absents/partiels, erreurs natives, déconnexion, changement de compte et reprise. Une capacité non vérifiée reste à investiguer, jamais « impossible » par défaut.

## 8. Design brief

Vues existantes, mêmes interactions pour les capacités communes ; limitations au point d'usage. Le brief complet sera écrit dans `specs/design/provider-effective-capabilities.md` au gel si le lot modifie l'UI.

## 9. Acceptance criteria

- [ ] Un panneau lisible ne rend pas automatiquement toutes ses actions disponibles.
- [ ] Un appel IPC direct ne contourne pas une opération indisponible.
- [ ] Manque d'intégration, état temporaire et limite démontrée sont distingués.
- [ ] Les payloads/contrôles nécessaires sont étayés par code, documentation officielle et captures réelles lorsque requis.
- [ ] Les régressions sur shell, git/diff, worktrees, layout, notifications et continuité liées aux événements modifiés sont couvertes.
- [ ] §5 complet, brief applicable et tests d'acceptation définis avant passage à frozen/Ready to build.

## Remediation

(Vide ; aucune revue.)
