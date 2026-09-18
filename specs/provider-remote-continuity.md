---
id: provider-remote-continuity
title: "16 · Remote et cloud : équivalents et limites prouvées"
status: draft
branch: feat/provider-remote-continuity
created: 2026-09-17
depends_on: [provider-effective-capabilities]
reviewed_base:
reviewed_digest:
design_files: []
---

# 16 · Remote et cloud : équivalents et limites prouvées

> Draft de découpage — non dispatchable. Les critères ci-dessous fixent la cible, pas un contrat gelé.
> Programme : [provider-capability-parity](provider-capability-parity.md), phase 4.
> Ordre choisi sur délégation utilisateur du 2026-09-17 ; un ticket Obsidian porte exactement cet identifiant.

## 1. Summary

Étudier les usages remote/cloud existants sans exclure d'office les autres moteurs.

## 2. Goals & non-goals

- Séparer service propriétaire, adoption de session et besoin utilisateur de continuité distante.
- Vérifier les interfaces officiellement accessibles pour les moteurs intégrés.
- En déduire un lot implémentable ou des limites démontrées, avec preuves par combinaison.

La cible globale reste celle du programme ; les capacités des lots voisins n'en sont pas exclues. Aucun nouveau provider ni parité de qualité des modèles. Découper encore avant gel si le contrat dépasse environ 300 lignes, en créant les tickets correspondants.

## 3. User stories / flows

À détailler au gel dans les vues existantes, souris et clavier inclus. L'action affichée doit produire un effet vérifié dans le bon moteur, compte et modèle.

## 4. Functional requirements

Les exigences FR numérotées seront dérivées des preuves et des critères §9. Aucun payload ou contrôle natif ne doit être inventé pour combler une preuve manquante.

## 5. API contract

Contrats existants à étendre en place : `contract/remote-control.ts`, `contract/cloud-sessions.ts`, `contract/common.ts`. Types, canaux, validation et erreurs exacts restent à figer après les points ci-dessous. Pas de deuxième contrat propriétaire d'un domaine existant.

- [ ] Investiguer les équivalents réellement proposés sans ajouter de nouveau provider.
- [ ] Figer les critères d'une limite démontrée et d'un complément possible.

## 6. Data & state

Définir sources d'autorité, fraîcheur, propriété, invalidation et persistance au gel. Garder compte/moteur/protocole distincts et les fils natifs séparés des transcripts rendus. Les implémenteurs ne doivent pas déduire ces décisions de ce draft.

## 7. Edge cases & errors

Documenter au gel les cas absents/partiels, erreurs natives, déconnexion, changement de compte et reprise. Une capacité non vérifiée reste à investiguer, jamais « impossible » par défaut.

## 8. Design brief

Vues existantes, mêmes interactions pour les capacités communes ; limitations au point d'usage. Le brief complet sera écrit dans `specs/design/provider-remote-continuity.md` au gel si le lot modifie l'UI.

## 9. Acceptance criteria

- [ ] Chaque usage remote/cloud possède une conclusion sourcée pour chaque moteur.
- [ ] Une absence d'intégration n'est jamais étiquetée impossibilité du fournisseur.
- [ ] Si un complément est réalisable, son ticket d'implémentation et ses critères sont créés avant clôture.
- [ ] Les payloads/contrôles nécessaires sont étayés par code, documentation officielle et captures réelles lorsque requis.
- [ ] Les régressions sur shell, git/diff, worktrees, layout, notifications et continuité liées aux événements modifiés sont couvertes.
- [ ] §5 complet, brief applicable et tests d'acceptation définis avant passage à frozen/Ready to build.

## Remediation

(Vide ; aucune revue.)
