---
id: provider-tool-parity
title: Tool and question parity for the Francois loop
status: draft
branch: feat/provider-tool-parity
created: 2026-09-17
depends_on: [provider-effective-capabilities, capability-registry]
reviewed_base:
reviewed_digest:
design_files: []
---

# 11 · Outils et questions dans la boucle François

> Draft de découpage, non dispatchable ; programme [provider-capability-parity](provider-capability-parity.md), phase 3.

## 1. Summary

Compléter les opérations de la boucle François et la restitution commune des outils, plans et questions. Les six outils actuels ne constituent pas une preuve de parité avec l'expérience Claude.

## 2. Goals & non-goals

- Inventorier les opérations réellement proposées : fichiers/recherche, exécution, web, plans/tâches et questions utilisateur.
- Fournir les compléments réalisables à la boucle François avec permissions et résultats effectifs.
- Restituer plans, progression et contenus de raisonnement effectivement exposés par les moteurs, sans inventer de contenu.
- Agents et MCP sont livrés par leurs tickets dédiés ; aucune nouvelle source payante ni nouveau provider choisi implicitement par ce draft.

## 3. User stories / flows

L'utilisateur retrouve l'activité et les résultats des opérations communes, répond à une question de l'agent puis voit le travail reprendre. Les flows exacts souris/clavier sont à préciser au gel.

## 4. Functional requirements

Établir une matrice par opération, pas seulement par nom d'outil. Les compléments passent par le gate du compte, respectent annulation et bornes, puis produisent des événements vérifiables. La suppression actuelle de plan/thought dans les adaptateurs n'est pas une limite du provider.

## 5. API contract

À geler dans les contrats existants `multi-provider-openai.ts`, `session-questions.ts`, `permission-guardrails.ts`, `conversation-view.ts` et `common.ts`.

- [ ] Comparer outils réellement présents dans François/Claude et chemins des trois autres moteurs.
- [ ] Définir les compléments, leurs backends disponibles, schémas et erreurs ; créer des tickets supplémentaires si le contrat dépasse environ 300 lignes.
- [ ] Figer portée des questions/plans et reprise après réponse, refus ou annulation.

## 6. Data & state

Préciser état des outils/questions/plans, propriété et persistance au gel. Les sorties disponibles au modèle ne sont pas automatiquement des contenus de raisonnement affichables ; ne restituer que ce que le moteur expose à cette fin.

## 7. Edge cases & errors

Outil inconnu, endpoint sans tool calling, refus, annulation, réponse tardive et perte de connexion doivent recevoir des comportements explicites. Une absence de backend web vérifié reste à instruire, pas à masquer par un résultat fictif.

## 8. Design brief

Réutiliser conversation, cartes d'outils, questions et plans existants. Brief autonome à écrire au gel si l'UI change.

## 9. Acceptance criteria

- [ ] Chaque opération Claude de référence possède un chemin intégré ou une limite démontrée dans la matrice.
- [ ] La boucle François pose une question interactive et reprend avec sa réponse ; refus/annulation sont traités.
- [ ] Un outil annoncé exécute effectivement l'opération sous le gate et restitue résultat/erreur.
- [ ] Plans/progression et contenus exposés sont correctement traduits sur chaque moteur, avec tests d'événements et captures nécessaires.
- [ ] Contrat complet, critères et brief applicables avant statut frozen.

## Remediation

(Vide ; aucune revue.)
