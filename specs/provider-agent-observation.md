---
id: provider-agent-observation
title: "06 · Sous-agents : suivi et conversations"
status: draft
branch: feat/provider-agent-observation
created: 2026-09-17
depends_on: [codex-interactive-session, grok-interactive-session]
reviewed_base:
reviewed_digest:
design_files: []
---

# 06 · Sous-agents : suivi et conversations

> Draft de découpage — non dispatchable. Les critères ci-dessous fixent la cible, pas un contrat gelé.
> Programme : [provider-capability-parity](provider-capability-parity.md), phase 2.
> Ordre choisi sur délégation utilisateur du 2026-09-17 ; un ticket Obsidian porte exactement cet identifiant.

## 1. Summary

Présenter les enfants natifs dans les mêmes vues avec parenté, état, activité et conversation.

## 2. Goals & non-goals

- Traduire agents Claude/Codex/Grok et leurs descendants vers le modèle commun.
- Distinguer identifiants natifs et identifiants UI, relier les conversations et erreurs.
- Conserver limites de mémoire, pagination, troncature déclarée et réhydratation.

La cible globale reste celle du programme ; les capacités des lots voisins n'en sont pas exclues. Aucun nouveau provider ni parité de qualité des modèles. Découper encore avant gel si le contrat dépasse environ 300 lignes, en créant les tickets correspondants.

## 3. User stories / flows

À détailler au gel dans les vues existantes, souris et clavier inclus. L'action affichée doit produire un effet vérifié dans le bon moteur, compte et modèle.

## 4. Functional requirements

Les exigences FR numérotées seront dérivées des preuves et des critères §9. Aucun payload ou contrôle natif ne doit être inventé pour combler une preuve manquante.

## 5. API contract

Contrats existants à étendre en place : `contract/common.ts`, `contract/agents-panel.ts`, `contract/async-agents.ts`, `contract/agent-tab.ts`. Types, canaux, validation et erreurs exacts restent à figer après les points ci-dessous. Pas de deuxième contrat propriétaire d'un domaine existant.

- [ ] Capturer découverte/souscription/transcript des enfants natifs pour chaque CLI.
- [ ] Préciser origine des activités et garanties après redémarrage.

## 6. Data & state

Définir sources d'autorité, fraîcheur, propriété, invalidation et persistance au gel. Garder compte/moteur/protocole distincts et les fils natifs séparés des transcripts rendus. Les implémenteurs ne doivent pas déduire ces décisions de ce draft.

## 7. Edge cases & errors

Documenter au gel les cas absents/partiels, erreurs natives, déconnexion, changement de compte et reprise. Une capacité non vérifiée reste à investiguer, jamais « impossible » par défaut.

## 8. Design brief

Vues existantes, mêmes interactions pour les capacités communes ; limitations au point d'usage. Le brief complet sera écrit dans `specs/design/provider-agent-observation.md` au gel si le lot modifie l'UI.

## 9. Acceptance criteria

- [ ] Un enfant réellement lancé apparaît et reçoit les événements de son propre flux.
- [ ] Des descendants de noms identiques ne se confondent pas entre comptes ou parents.
- [ ] Reconnexion/événements dupliqués ne dupliquent ni agents ni activité.
- [ ] Les payloads/contrôles nécessaires sont étayés par code, documentation officielle et captures réelles lorsque requis.
- [ ] Les régressions sur shell, git/diff, worktrees, layout, notifications et continuité liées aux événements modifiés sont couvertes.
- [ ] §5 complet, brief applicable et tests d'acceptation définis avant passage à frozen/Ready to build.

## Remediation

(Vide ; aucune revue.)
