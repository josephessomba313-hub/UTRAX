# UTRAX Backend — Guide de démarrage (Phase 1)

Ce dossier contient le vrai serveur : il parle à une vraie base de données
MySQL, gère de vrais mots de passe (chiffrés), et sert les données aux trois
côtés de l'application (École, Parent, UTRAX). Ce n'est plus une simulation.

## Ce que ce serveur fait déjà

- **Côté École** : connexion sécurisée (code + mot de passe), liste des
  élèves avec solde calculé automatiquement, inscription d'un élève,
  enregistrement d'un paiement en caisse.
- **Côté Parent** : recherche publique d'un élève (école → classe →
  matricule), consultation de sa fiche et de son historique, initiation
  d'un paiement (⚠️ enregistré directement pour l'instant — pas encore
  relié à un vrai opérateur Mobile Money, ça viendra en Phase 4).
- **Côté UTRAX** : création/retrait d'établissements, liste de toutes les
  écoles — protégé par une clé d'administrateur que toi seul connais.

## Étape 1 — Installer MySQL facilement (avec une interface graphique)

Plutôt que d'installer MySQL en ligne de commande (compliqué sans
expérience), utilise un outil tout-en-un avec une interface visuelle :

- **Windows/Mac/Linux** : télécharge **XAMPP** → https://www.apachefriends.org
- Installe-le normalement (Suivant, Suivant...)
- Ouvre le "Panneau de contrôle XAMPP" et clique sur **Start** à côté de
  **MySQL**
- Clique sur **Admin** à côté de MySQL — ça ouvre **phpMyAdmin** dans ton
  navigateur, une interface visuelle pour gérer la base de données

## Étape 2 — Créer la base de données

1. Dans phpMyAdmin, clique sur l'onglet **SQL** en haut
2. Ouvre le fichier `utrax-schema-mysql.sql` (fourni dans ce paquet) avec un
   éditeur de texte, copie tout son contenu
3. Colle-le dans la zone de texte SQL de phpMyAdmin, puis clique **Exécuter**
4. Tu dois voir apparaître une base `utrax` avec ses tables dans la colonne
   de gauche — c'est fait

## Étape 3 — Installer Node.js (si pas déjà fait)

Va sur **https://nodejs.org**, télécharge la version **LTS**, installe-la.
Vérifie avec `node -v` dans un terminal (voir le guide du prototype visuel
pour le détail d'ouverture d'un terminal).

## Étape 4 — Configurer le serveur

1. Dans le dossier `utrax-backend`, trouve le fichier `.env.example`
2. Fais-en une copie, renomme la copie en `.env` (juste ce nom, sans
   "example")
3. Ouvre `.env` avec un éditeur de texte. Avec XAMPP, les valeurs par
   défaut fonctionnent normalement telles quelles (`DB_USER=root`,
   `DB_PASSWORD=` vide) — ne change que si tu as personnalisé ton MySQL
4. Change `ADMIN_KEY` par un mot de passe que toi seul connais — c'est ta
   clé pour les actions UTRAX (créer/retirer une école)

## Étape 5 — Installer les dépendances et démarrer

Ouvre un terminal dans le dossier `utrax-backend` (même méthode que pour le
prototype visuel), puis :

```
npm install
npm run seed
npm run dev
```

- `npm install` télécharge ce dont le serveur a besoin
- `npm run seed` crée un établissement de démonstration dans la vraie base
  de données (code `SEM2026`, mot de passe `semence2026`)
- `npm run dev` démarre le serveur — tu dois voir :
  `UTRAX API démarrée sur http://localhost:4000`

## Étape 6 — Vérifier que ça marche

Ouvre ton navigateur à **http://localhost:4000/api/health** — tu dois voir
`{"statut":"ok"}`. Ça confirme que le serveur tourne et parle à la base de
données.

Pour tester la connexion école, tu peux utiliser un outil comme **Postman**
(gratuit, https://www.postman.com) ou simplement demander mon aide pour
tester ensemble à l'étape suivante.

## Et maintenant ?

Ce serveur existe, mais **le prototype visuel qu'on a construit avant ne lui
parle pas encore** — il utilise toujours ses données simulées en mémoire.
La prochaine étape (qu'on fera ensemble) : brancher l'interface visuelle sur
ce vrai serveur, pour que les trois côtés (École, Parent, UTRAX) partagent
enfin les mêmes vraies données, stockées dans MySQL, accessibles depuis
n'importe quel appareil — pas seulement le navigateur qui a fait l'action.
