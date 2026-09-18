---
id: provider-workflow-runtime
title: "10 · Workflows et orchestration portables"
status: draft
branch: feat/provider-workflow-runtime
created: 2026-09-17
depends_on: [provider-agent-control, capability-registry]
reviewed_base:
reviewed_digest:
design_files: []
---

# 10 · Workflows et orchestration portables

> Draft de découpage — non dispatchable. Les critères ci-dessous fixent la cible, pas un contrat gelé.
> Programme : [provider-capability-parity](provider-capability-parity.md), phase 3.
> Ordre choisi sur délégation utilisateur du 2026-09-17 ; un ticket Obsidian porte exactement cet identifiant.

## 1. Summary

Conserver les vues de workflows avec des phases et enfants réellement exécutés sur les moteurs supportés.

## 2. Goals & non-goals

- Distinguer workflow natif, orchestration François et simples listes d'agents.
- Exécuter et suivre les dépendances/phases avec annulation et erreurs.
- Réutiliser les détails et conversations existants sans inventer de progression.

La cible globale reste celle du programme ; les capacités des lots voisins n'en sont pas exclues. Aucun nouveau provider ni parité de qualité des modèles. Découper encore avant gel si le contrat dépasse environ 300 lignes, en créant les tickets correspondants.

## 3. User stories / flows

À détailler au gel dans les vues existantes, souris et clavier inclus. L'action affichée doit produire un effet vérifié dans le bon moteur, compte et modèle.

## 4. Functional requirements

Les exigences FR numérotées seront dérivées des preuves et des critères §9. Aucun payload ou contrôle natif ne doit être inventé pour combler une preuve manquante.

## 5. API contract

Contrats existants à étendre en place : `contract/workflow-panel.ts`, `contract/workflow-details.ts`, `contract/common.ts`. Types, canaux, validation et erreurs exacts restent à figer après les points ci-dessous. Pas de deuxième contrat propriétaire d'un domaine existant.

- [ ] Figer la sémantique et le format d'orchestration sans choisir un DSL spéculatif.
- [ ] Vérifier le format natif actuellement utilisé et les garanties de reprise.

## 6. Data & state

Définir sources d'autorité, fraîcheur, propriété, invalidation et persistance au gel. Garder compte/moteur/protocole distincts et les fils natifs séparés des transcripts rendus. Les implémenteurs ne doivent pas déduire ces décisions de ce draft.

## 7. Edge cases & errors

Documenter au gel les cas absents/partiels, erreurs natives, déconnexion, changement de compte et reprise. Une capacité non vérifiée reste à investiguer, jamais « impossible » par défaut.

## 8. Design brief

Vues existantes, mêmes interactions pour les capacités communes ; limitations au point d'usage. Le brief complet sera écrit dans `specs/design/provider-workflow-runtime.md` au gel si le lot modifie l'UI.

## 9. Acceptance criteria

- [ ] Les phases déclarées ne sont pas présentées comme exécutées sans événement réel.
- [ ] Arrêt/reprise préservent les relations du run et de ses agents.
- [ ] Chaque runtime reçoit un chemin d'exécution vérifié ou une limite documentée.
- [ ] Les payloads/contrôles nécessaires sont étayés par code, documentation officielle et captures réelles lorsque requis.
- [ ] Les régressions sur shell, git/diff, worktrees, layout, notifications et continuité liées aux événements modifiés sont couvertes.
- [ ] §5 complet, brief applicable et tests d'acceptation définis avant passage à frozen/Ready to build.

## Remediation

(Vide ; aucune revue.)
