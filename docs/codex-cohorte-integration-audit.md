# Audit et corrections Codex / Cohorte — 30 septembre 2026

## Périmètre et références

Audit des fonctionnalités existantes de François, Codex d'abord, puis Cohorte. Les ressources MCP et les questions sont des exemples du périmètre, pas sa limite. Les adaptations concernent les contrats, React, le moteur de sessions Rust, les comptes et le service Cohorte Python.

Références vérifiées : schéma App Server généré par le Codex installé 0.159.x, appels locaux sans modèle avec Codex 0.159.2, [documentation officielle App Server](https://developers.openai.com/codex/app-server), et source Python du dépôt voisin `../cohorte` (1.0.0a18, protocole `cohorte/1`). Aucun changement des identifiants globaux, aucun run chez un fournisseur, aucune publication Git.

## Fonctionnalités Codex

| Fonctionnalité François | Intégration et correction | Vérification |
| --- | --- | --- |
| Comptes, connexion et identité | Réservation atomique du login, succès/échec attribués au compte, fin et récupération des enfants après timeout. Ressources partagées héritées, dont agents et hooks, sans copier authentification, historique ou sessions. Surcharges propres au compte conservées. `CODEX_HOME` utilisateur respecté. | Tests de comptes, configuration et cycle de processus. OAuth réel non exécuté. |
| Configuration de projet / MCP | Configuration native effective du compte et du cwd, couches natives, pagination des serveurs. Liste, détail, ajout, retrait, reconnexion OAuth et rechargement utilisent le protocole Codex. Les serveurs hérités peuvent être désactivés sans modifier la source partagée. État inconnu conservé. | Fixtures natives et appels réels de découverte/configuration/rechargement dans un home temporaire. Serveurs distants authentifiés non exécutés. |
| Mise à jour MCP dans l'interface | Les événements récents priment sur les réponses de chargement tardives. Rafraîchissement natif après démarrage/OAuth sans bloquer le lecteur RPC. | Tests des hooks, du flux MCP et du transport. |
| Skills | Découverte native avec chemins, portée, plugin et activation. Activation écrite nativement. Invocation par entrée `skill` native et syntaxe `$name`. Ressources partagées conservées. | Fixtures et découverte réelle du CLI sans modèle. |
| Profils et instructions | Instructions de remplacement transmises au thread. Arguments Codex validés avant lancement ; les options non intégrées produisent une erreur explicite. Textes UI adaptés au runtime. | Tests de prévalidation et de paramètres réellement reçus par un pair natif. |
| Modèles, effort et permissions | Modèle et effort exacts au prochain tour ; mode Plan transmis comme collaboration native. Autorité des réponses aux demandes disponible uniquement avec une connexion native active. Édition des règles Claude et auto-approbation Git désactivées pour Codex. | Tests de paramètres, de capacités et de demandes natives. |
| Création, envoi, FIFO, images | Transport App Server persistant, attachements natifs, messages en attente traités par la file François. Aucun acquittement de RPC ne remplace la fin réelle du tour. | Tests existants et pairs natifs déterministes. Aucun tour de modèle facturable. |
| Questions utilisateur | Identifiants et options conservés, réponse avec l'identifiant RPC exact, contrôle de portée, rejeux et annulation. Champs secrets masqués dans les confirmations et la persistance. | Tests du ledger, des décisions, de la projection et de l'UI. |
| Formulaires et URL MCP | Formulaires typés convertis en questions, valeurs validées, champs secrets masqués. URL HTTP(S) ouverte seulement sur clic et pour la demande encore présente ; ce clic n'accorde pas la permission. | Tests natifs et validation de type. Parcours navigateur réel à vérifier. |
| Questions asynchrones | Les questions et choix joints aux messages Codex restent visibles. Leur réponse passe par un nouveau message, conformément à cette forme du protocole sans identifiant de demande RPC. | Régression sur le message natif. |
| Commandes et outils | Sorties de commande et progression MCP visibles pendant l'exécution, aperçus bornés. Sortie finale native prioritaire. Détails conservés dans le transcript et le sidecar. | Tests de progression, de fin et de persistance ; rendu partagé existant. |
| Plans, raisonnement, images et autres étapes | Plans, compaction, vues d'images, génération, revue et résultats d'outils publics visibles. Seul le résumé public du raisonnement est projeté. | Régressions de contenu public et absence de contenu privé. |
| Sous-agents | Création, transcript enfant, statut et arrêt issus des threads natifs. Une réponse de spawn ne déclare jamais le sous-agent terminé. L'arrêt envoie une interruption réelle. Échecs de souscription remontés ; anciennes fins et snapshots rejetés selon le tour et la génération. | Fixture de collaboration et lifecycle ; exécution de sous-agents chez le fournisseur non testée. |
| Reprise, interruption, erreurs | Ancre exacte du même compte ; aucune reprise silencieuse sur un nouveau thread. Demandes périmées/résolues rejetées et enfants fermés proprement. | Tests existants du transport, de reconnexion, de reprise et de contrôle. |
| Compaction et commandes interactives | `/compact` utilise `thread/compact/start` et attend le tour natif. Help/commandes et palette adaptés aux capacités Codex. | Régressions natives et frontend. |
| Contexte et consommation | Fenêtre native, compteurs de contexte, entrée/sortie/cache affichés. Le prix d'un abonnement n'est pas inventé à partir des tokens. | Projection de métriques et tests de capacités. |
| Contrôle distant | Activation éphémère sur le même processus App Server, attente de connexion avant appairage, code manuel natif renouvelable, expiration convertie en millisecondes, état connecté même sans code mémorisé, arrêt confirmé par Codex. | Tests natifs et de réduction UI. Appairage d'un client distant réel non exécuté. |
| Sessions cloud et workflows | Le navigateur cloud existant est celui de Claude et exige un compte Claude éligible conservé pendant tout le parcours. L'orchestration Codex passe par Cohorte. | Régressions de sélection des comptes et de capacités. |
| Projet, worktree, diff, shell, historique et extensions | Surfaces communes conservées ; les chemins macOS canoniques sont reconnus pour les changements de fichiers Codex. | Suites générales et tests de frontières. WSL/macOS interactif à vérifier hors sandbox. |

### Distinctions conservées

Les messages FIFO de François sont fonctionnels ; le produit ne propose actuellement ni steering natif en cours de tour, ni file follow-up native. Les capacités correspondantes restent indisponibles. Les règles persistantes propres à Claude ne sont pas présentées comme des règles Codex. Les schémas MCP non pris en charge (notamment `$ref` et la vérification utilisateur spécifique OpenAI) échouent explicitement plutôt que de recevoir une réponse fictive.

L'expiration d'appairage Codex est exprimée en secondes Unix dans la [source native d'enrollment](https://github.com/openai/codex/blob/main/codex-rs/app-server-transport/src/transport/remote_control/enroll.rs). Le contrat François emploie des millisecondes ; la conversion est contrôlée et couverte par une régression.

## Fonctionnalités Cohorte

| Fonctionnalité | Correction / validation |
| --- | --- |
| Détection et diagnostic | CLI et data-dir configurés conservés. Diagnostic par `cohorte doctor --repo`, avec résultats/remédiations natifs. Une réponse du service n'est plus présentée comme un diagnostic fournisseur réussi. |
| Initialisation | Questions, analyse et besoin de revue rendus visibles ; actions interactives exécutées dans le terminal avec le bon dépôt et la configuration exacte. |
| Intake et questions de préparation | Questions non résolues affichées ; réponses réellement fournies à Cohorte. Inbox des demandes de projet/feature indépendante des événements de run. |
| Brainstorm et reprise de préparation | Provenance des artefacts/étapes natives conservée ; `--from-intake` ou `--continue` utilisés selon l'objet source, sans option `--feature-id` inexistante. |
| Démarrage réel | Lancement de `loop --live` à partir des artefacts frozen/profile approuvés ; identité, racine enregistrée, fichiers et empreintes vérifiés. Le profil exact est lu par `profile_ref` : la représentation RPC expurgée ne sert pas au calcul de son empreinte. Une simple ligne `runs.start` en base ne constitue plus une exécution. |
| Pause, reprise et annulation | Reprise par runner `resume --live` dans les états réellement admis, admission affichée comme pending avec exitCode inconnu. Pause/annulation durable avant attente de sortie gracieuse. Après arrêt forcé, les leases non prouvées libérées sont signalées par `WORKER_NOT_STOPPED`. Stop/shutdown ferme et récupère uniquement les arbres possédés. |
| Vue du run | Export natif projeté en phases, tâches, essais, contrôles, findings, artefacts, worktrees et usage. Au-delà de 768 KiB, repli borné sur les événements paginés : contexte et phases conservés, preuves limitées signalées, aucune autorisation de publication inventée. État du host inconnu conservé comme inconnu. Événements inconnus conservés pour diagnostic. |
| Suivi | Runs, inbox et demandes actualisés même sans nouvel événement. Demandes expirées/résolues supprimées, runs retirés réconciliés, curseur réinitialisé si la base native est remplacée. |
| Autorisations et publication | Une revue propre ne vaut pas approbation de publication. `shipReady` exige l'approbation native de la dernière demande pour le candidat actuel. Pour `spec.freeze`, aperçu intégral de spec/plan/profil exacts et empreintes vérifiées ; approbation directe indisponible si les preuves sont absentes ou trop volumineuses. Approval et `ship --live` sont deux actions distinctes. |
| Terminal et erreurs | Même CLI, data-dir et racine que le service ; terminal natif imposé pour ce service hôte, arguments/réponses quotés pour le shell effectif, y compris PowerShell. Activation du bon pane en vue partagée. Codes, messages et remédiations RPC conservés. |

Une demande refactor native sans project_id/feature_id et avec seulement des chemins relatifs ne permet pas d'établir à quel projet elle appartient. Elle n'est pas attribuée arbitrairement au projet ouvert. Les chemins absolus contenus dans le projet permettent de la rattacher ; la lacune de protocole demeure pour les demandes relatives non scoped.

## Preuves et limites

| Vérification locale | Résultat |
| --- | --- |
| `npm test -- --reporter=dot` | 3 713 tests, 229 suites réussies. |
| `cargo test --offline --quiet` avec exclusions réseau ci-dessous | 2 058 tests unitaires + 7 tests d'intégration réussis ; 13 tests ignorés par défaut, 10 exclus à cause du sandbox. |
| `npm run quality` | Réussi : TypeScript, ESLint, conventions, 91 tests de frontières, rustfmt et Clippy tous targets. Avertissements préexistants conservés. |
| `npm run build` | Réussi ; avertissement Vite préexistant sur la taille des chunks. |
| Codex 0.159.2, home temporaire | Initialisation, lecture/écriture de configuration, rechargement MCP, état MCP et découverte de skills exercés sans modèle. |
| Source RPC Cohorte locale → projection Rust | 3 régressions réussies : approbation du candidat courant, aperçu complet de freeze, export volumineux et repli paginé. |
| Revues indépendantes | Verdict `SHIP` sur les surfaces frontend et core ; aucun constat restant après correction des 15 constats initiaux. |

Les dix exclusions Rust concernent les tests de probes HTTP et de réponses fournisseur qui ouvrent un port TCP local, ainsi que le handshake Cohorte sur socket Unix. Les premiers essais non filtrés ont confirmé le refus des binds par le sandbox ; leurs assertions ne sont pas déclarées réussies. Les tests ignorés gardent leurs prérequis explicites dans le code, dont un service Cohorte isolé.

Les fixtures contrôlent les échanges wire et la projection jusqu'au produit, sans fournir la preuve d'un tour réel chez OpenAI. Les trois régressions générées depuis le Cohorte voisin peuvent être relancées avec son environnement Python :

```sh
../cohorte/.venv/bin/python scripts/integration/cohorte-source-rpc.py
```

La découverte/configuration a également été exercée avec le Codex installé dans un home temporaire. Le protocole du Cohorte voisin a été exercé avec sa vraie implémentation RpcServer et une base temporaire : projets/features, demandes, réponses, export et approval du candidat actuel. Le démarrage du service Cohorte sur socket Unix échoue dans ce sandbox avec `PermissionError: [Errno 1] Operation not permitted` à `sock.bind`.

Restent à qualifier dans l'application hors sandbox : OAuth des comptes et MCP, requête de modèle réelle (texte/image), interaction avec un serveur MCP distant, client remote Codex, WSL, runner Cohorte chez un fournisseur et publication réelle. Aucun de ces parcours n'est déclaré validé par les tests locaux.
