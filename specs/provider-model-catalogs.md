---
id: provider-model-catalogs
title: "02 · Catalogues Claude, Grok et endpoints"
status: draft
branch: feat/provider-model-catalogs
created: 2026-09-17
depends_on: [codex-model-catalog]
reviewed_base:
reviewed_digest:
design_files: []
---

# 02 · Catalogues Claude, Grok et endpoints

> Draft de découpage — non dispatchable. Les critères ci-dessous fixent la cible, pas un contrat gelé.
> Programme : [provider-capability-parity](provider-capability-parity.md), phase 1.
> Ordre choisi sur délégation utilisateur du 2026-09-17 ; un ticket Obsidian porte exactement cet identifiant.

## 1. Summary

Compléter la découverte native et les métadonnées des autres moteurs avec une autorité par compte.

## 2. Goals & non-goals

- Corriger le catalogue Claude partagé utilisant les credentials globaux.
- Fusionner chez Grok le catalogue natif et les modèles configurés, avec défaut et efforts vérifiés.
- Qualifier les listes et overrides des endpoints, la fraîcheur, les modalités et les limites réellement connues.

La cible globale reste celle du programme ; les capacités des lots voisins n'en sont pas exclues. Aucun nouveau provider ni parité de qualité des modèles. Découper encore avant gel si le contrat dépasse environ 300 lignes, en créant les tickets correspondants.

## 3. User stories / flows

À détailler au gel dans les vues existantes, souris et clavier inclus. L'action affichée doit produire un effet vérifié dans le bon moteur, compte et modèle.

## 4. Functional requirements

Les exigences FR numérotées seront dérivées des preuves et des critères §9. Aucun payload ou contrôle natif ne doit être inventé pour combler une preuve manquante.

## 5. API contract

Contrats existants à étendre en place : `contract/session-engine.ts`, `contract/common.ts`, `contract/multi-account.ts`. Types, canaux, validation et erreurs exacts restent à figer après les points ci-dessous. Pas de deuxième contrat propriétaire d'un domaine existant.

- [ ] Capturer grok models/inspection sur la version cible et figer le format exploitable.
- [ ] Établir l'interface officielle/CLI Claude appropriée pour un catalogue par compte.
- [ ] Fixer métadonnées et fallback par endpoint sans supposer une API universelle.

## 6. Data & state

Définir sources d'autorité, fraîcheur, propriété, invalidation et persistance au gel. Garder compte/moteur/protocole distincts et les fils natifs séparés des transcripts rendus. Les implémenteurs ne doivent pas déduire ces décisions de ce draft.

## 7. Edge cases & errors

Documenter au gel les cas absents/partiels, erreurs natives, déconnexion, changement de compte et reprise. Une capacité non vérifiée reste à investiguer, jamais « impossible » par défaut.

## 8. Design brief

Vues existantes, mêmes interactions pour les capacités communes ; limitations au point d'usage. Le brief complet sera écrit dans `specs/design/provider-model-catalogs.md` au gel si le lot modifie l'UI.

## 9. Acceptance criteria

- [ ] Aucun compte n'affiche le catalogue ou les credentials d'un autre.
- [ ] Les modèles natifs et personnalisés Grok restent accessibles ensemble.
- [ ] Source indisponible, override et métadonnée inconnue ont des états distincts.
- [ ] Les payloads/contrôles nécessaires sont étayés par code, documentation officielle et captures réelles lorsque requis.
- [ ] Les régressions sur shell, git/diff, worktrees, layout, notifications et continuité liées aux événements modifiés sont couvertes.
- [ ] §5 complet, brief applicable et tests d'acceptation définis avant passage à frozen/Ready to build.

## Remediation

(Vide ; aucune revue.)
