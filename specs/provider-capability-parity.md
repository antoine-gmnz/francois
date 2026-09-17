---
id: provider-capability-parity
title: Functional parity across integrated runtimes
status: draft
branch:
created: 2026-09-17
depends_on: []
reviewed_base:
reviewed_digest:
design_files: []
---

# Parité fonctionnelle entre moteurs intégrés

> Programme de suivi, non dispatchable comme une feature monolithique. Construire les specs enfants gelées, pas ce document.
> Périmètre confirmé le 2026-09-17 ; découpage/ordre délégués par l'utilisateur avec exigence d'un ticket Obsidian par lot.

## 1. Summary

François doit offrir les mêmes informations et actions avec Claude Code, Codex, Grok et sa propre boucle sur endpoints compatibles, dans les limites réelles prouvées. Intégrer les capacités natives et compléter les manques réalisables. La référence Claude est vérifiée : une action locale fictive ne constitue pas un comportement à reproduire.

## 2. Goals & non-goals

Modèles/efforts/réglages, outils et restitution, permissions/questions, sous-agents observables et contrôlables, MCP, skills, workflows, contexte/consommation/quotas, pièces jointes et continuité. Les services remote/cloud font l'objet d'un ticket d'investigation explicite. Conserver les surfaces communes git/diff/shell/worktrees/layout/notifications.

Hors périmètre : égaliser la qualité intrinsèque des modèles, afficher une capacité fictive, ajouter des providers ou appeler « limite provider » un manque de l'adaptateur. Aucun lot différé n'est une exclusion du programme.

## 3. User stories / flows

L'utilisateur choisit son compte, retrouve les capacités et actions disponibles, suit et contrôle les agents, utilise ses ressources et reprend son travail. Les mêmes actions ont la même signification ; les différences réelles sont expliquées au point d'usage. Les flows précis vivent dans les specs enfants.

## 4. Functional requirements

Une capacité est livrée uniquement après vérification de son effet et de sa restitution. Une action qui ne fait que modifier la présentation n'est pas une exécution réussie. Toute capacité du périmètre a un propriétaire ci-dessous. Une inconnue conserve son travail d'investigation jusqu'à une conclusion prouvée.

| Phase | Livraison / spec | Statut à la création | Dépendances du programme |
| --- | --- | --- | --- |
| 1 | [01 · Catalogue Codex et efforts complets](codex-model-catalog.md) | frozen | intégrations existantes |
| 1 | [02 · Catalogues Claude, Grok et endpoints](provider-model-catalogs.md) | draft | `codex-model-catalog` |
| 1 | [03 · Capacités effectives par action](provider-effective-capabilities.md) | draft | `codex-model-catalog` |
| 2 | [04 · Sessions Codex interactives](codex-interactive-session.md) | draft | `provider-effective-capabilities` |
| 2 | [05 · Sessions Grok interactives](grok-interactive-session.md) | draft | `provider-effective-capabilities` |
| 2 | [06 · Sous-agents : suivi et conversations](provider-agent-observation.md) | draft | `codex-interactive-session`, `grok-interactive-session` |
| 2 | [07 · Sous-agents : exécution, messages et arrêt réel](provider-agent-control.md) | draft | `provider-agent-observation` |
| 3 | [08 · Registre partagé et skills utilisables](capability-registry.md) | draft | `provider-effective-capabilities` |
| 3 | [09 · MCP natif et client François](provider-mcp-runtime.md) | draft | `capability-registry`, `codex-interactive-session`, `grok-interactive-session` |
| 3 | [10 · Workflows et orchestration portables](provider-workflow-runtime.md) | draft | `provider-agent-control`, `capability-registry` |
| 3 | [11 · Outils et questions dans la boucle François](provider-tool-parity.md) | draft | `provider-effective-capabilities`, `capability-registry` |
| 4 | [12 · Réglages, profils et commandes effectifs](provider-settings-parity.md) | draft | `provider-model-catalogs`, `codex-interactive-session`, `grok-interactive-session`, `capability-registry` |
| 4 | [13 · Compaction et continuité des sessions](provider-session-continuity.md) | draft | `codex-interactive-session`, `grok-interactive-session`, `provider-agent-control` |
| 4 | [14 · Contexte, consommation et quotas fiables](provider-usage-metrics.md) | draft | `provider-model-catalogs`, `codex-interactive-session`, `grok-interactive-session` |
| 4 | [15 · Pièces jointes et entrées multimodales](provider-input-parity.md) | draft | `provider-model-catalogs`, `codex-interactive-session`, `grok-interactive-session` |
| 4 | [16 · Remote et cloud : équivalents et limites prouvées](provider-remote-continuity.md) | draft | `provider-effective-capabilities` |

L'ordre est un ordre de priorité, pas une affirmation que les lots indépendants dépendent tous du précédent. Les dépendances ci-dessus constituent un graphe sans cycle. Le suivi d'avancement courant est le front-matter de chaque spec et sa carte Obsidian ; cette table date du découpage.

## 5. API contract

Aucun nouveau contrat monolithique. Chaque livraison gèle ses types, canaux et erreurs, et modifie en place les domaines existants. Frontend : `src` ; core : `src-tauri` et ses tests. Ne pas lancer d'implémenteur sur les drafts.

## 6. Data & state

Sources et capacités effectives par moteur/compte/modèle/version. Conserver les décisions Live et les responsabilités de `PIPELINE.md`. Le programme ne crée pas de registre, format ou état applicatif à lui seul.

## 7. Edge cases & errors

Chaque lot couvre sa continuité, isolation, annulation et dégradation. Captures authentifiées encore nécessaires pour contrôles d'enfants et transport Grok ; le CLI Grok est absent de l'environnement inspecté. Le probe anonyme Codex ne prouve pas les modèles autorisés sur le compte utilisateur.

## 8. Design brief

Pas de brief global : réutiliser les vues existantes. Chaque lot UI gelé possède son brief séparé. Le premier est `specs/design/codex-model-catalog.md`.

## 9. Acceptance criteria

- [ ] [01 · Catalogue Codex et efforts complets](codex-model-catalog.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [02 · Catalogues Claude, Grok et endpoints](provider-model-catalogs.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [03 · Capacités effectives par action](provider-effective-capabilities.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [04 · Sessions Codex interactives](codex-interactive-session.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [05 · Sessions Grok interactives](grok-interactive-session.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [06 · Sous-agents : suivi et conversations](provider-agent-observation.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [07 · Sous-agents : exécution, messages et arrêt réel](provider-agent-control.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [08 · Registre partagé et skills utilisables](capability-registry.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [09 · MCP natif et client François](provider-mcp-runtime.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [10 · Workflows et orchestration portables](provider-workflow-runtime.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [11 · Outils et questions dans la boucle François](provider-tool-parity.md) : livré, avec matrice par opération.
- [ ] [12 · Réglages, profils et commandes effectifs](provider-settings-parity.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [13 · Compaction et continuité des sessions](provider-session-continuity.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [14 · Contexte, consommation et quotas fiables](provider-usage-metrics.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [15 · Pièces jointes et entrées multimodales](provider-input-parity.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] [16 · Remote et cloud : équivalents et limites prouvées](provider-remote-continuity.md) : livré, ou conclusion de limite dûment prouvée pour le ticket d'investigation.
- [ ] Aucune capacité du brainstorm ne disparaît du périmètre par découpage.
- [x] Les seize tickets enfants existent dans Obsidian, avec dépendances et critères de fin ; chaque nouveau sous-découpage ajoute les tickets correspondants.
- [ ] Vérification finale de la matrice par runtime/compte/modèle/OS et de la continuité des surfaces communes.

## Remediation

(Vide ; aucune revue.)
