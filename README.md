# homebridge-rika-corso

Plugin [Homebridge](https://homebridge.io) pour piloter un poêle RIKA équipé
d'un module FireNet, exposé dans HomeKit comme un thermostat. Il couvre le
« mode Confort » du poêle : allumage/extinction et température de consigne.

> **Fork.** Version d'origine : `homebridge-rika-corso@1.0.5` de
> Maël Laroque ([@mael50](https://www.npmjs.com/~zaki_mael)), publiée le
> 31 octobre 2025. Aucun dépôt public n'étant déclaré dans les métadonnées npm,
> ce dépôt repart du tarball npm. Licence GNU GPLv3 conservée.

## Migration 1.x vers 2.0

La version 2.0 transforme le plugin en **plateforme** afin de publier un
accessoire par indicateur. Dans `config.json`, déplacez votre entrée du
tableau `accessories` vers `platforms` et remplacez la clé `accessory` par
`platform` :

```diff
-  "accessories": [ { "accessory": "RIKAFirenet", ... } ]
+  "platforms":   [ { "platform":  "RIKAFirenet", ... } ]
```

Apple Home découvrira quatre nouveaux accessoires à ranger dans vos pièces.
L'ancien thermostat, publié par le plugin en mode accessoire, disparaît et est
remplacé par le nouveau : les automatisations qui l'utilisaient doivent être
vérifiées.

## Ce que ce fork change

| Changement | Pourquoi |
|---|---|
| `request` remplacé par `fetch` natif | `request` est abandonné depuis 2020 et apportait **6 vulnérabilités sans correctif** (dont 2 critiques : SSRF, aléa non sûr dans `form-data`). Le plugin n'a maintenant **aucune dépendance**. |
| Logs de routine passés en `debug` | Le plugin écrivait ~3800 lignes/jour, ce qui noyait les avertissements des autres plugins. Les erreurs restent en niveau normal. |
| Une seule requête de statut en vol | Supprime les rafales de « Mise à jour déjà en cours, abandon... » : les appelants simultanés partagent la même requête. |
| HomeKit reçoit toujours une réponse | Avant, une requête en échec laissait les callbacks HomeKit en attente (« Pas de réponse »). On sert désormais la dernière valeur connue. |
| `config.schema.json` ajouté | Les réglages sont éditables depuis l'interface Homebridge, mot de passe masqué — plus besoin de modifier `config.json` à la main. |
| `engines` corrigé | Déclarait `homebridge: >=0.2.5`. Déclare maintenant `^1.8.0 \|\| ^2.0.0` et les versions de Node réellement supportées. |
| `registerAccessory()` corrigé | S'enregistrait sous l'identifiant `homebridge-rika-firenet`, différent du nom du paquet. |

## Prérequis

- Node.js 20 ou plus récent (pour `fetch` natif et `Headers.getSetCookie()`)
- Homebridge 1.8 ou 2.x

## Installation

Depuis ce dépôt :

```bash
sudo hb-service add homebridge-rika-corso@git+https://github.com/<compte>/homebridge-rika-corso.git
```

Ou, sur une installation Homebridge classique :

```bash
npm install -g git+https://github.com/<compte>/homebridge-rika-corso.git
```

## Configuration

Le plus simple est de passer par l'onglet *Plugins* de l'interface Homebridge,
qui affiche un formulaire depuis la version 1.1.0.

En éditant `config.json` à la main, la plateforme se déclare dans le tableau
`platforms` :

```json
{
  "platforms": [
    {
      "platform": "RIKAFirenet",
      "name": "Poele",
      "FirenetEmail": "mon@adresse.fr",
      "FirenetPassword": "monMotDePasse",
      "stoveID": "1234567"
    }
  ]
}
```

| Option | Requis | Défaut | Description |
|---|---|---|---|
| `platform` | oui | — | Doit valoir exactement `RIKAFirenet` |
| `name` | oui | — | Préfixe des cinq accessoires |
| `FirenetEmail` | oui | — | Identifiant du compte rika-firenet.com |
| `FirenetPassword` | oui | — | Mot de passe du compte |
| `stoveID` | oui | — | Identifiant du poêle |
| `updateInterval` | non | `60000` | Intervalle de rafraîchissement, en ms |
| `timeout` | non | `10000` | Expiration des requêtes HTTP, en ms |

**Le mot de passe est stocké en clair dans `config.json`.** Gardez ce fichier
en permissions `600` :

```bash
chmod 600 /var/lib/homebridge/config.json
```

### Trouver le `stoveID`

Connectez-vous sur [rika-firenet.com](https://www.rika-firenet.com) : il
apparaît dans l'URL de la page de résumé, `/web/summary/<stoveID>`.

## Niveau de pellets

Le poêle **n'a aucun capteur de niveau** dans son réservoir. Le plugin déduit
le restant du compteur cumulatif de pellets consommés (`parameterFeedRateTotal`,
en kg) et de la valeur relevée au dernier plein :

```
restant = capacité − (compteur actuel − compteur au dernier plein)
```

Le niveau est exposé dans HomeKit comme un **niveau de batterie** en pourcentage,
avec l'indicateur « batterie faible » sous le seuil configuré — utilisable dans
une automatisation pour être prévenu avant la panne sèche.

### Enregistrer un plein

**Le mécanisme fiable est l'interrupteur « plein »** exposé dans l'app Maison.
Il retombe de lui-même après activation. Désactivable via `refillSwitch`.

### Détection automatique

Un plein est enregistré quand le poêle **cesse de signaler son couvercle
ouvert**. Le poêle n'expose aucun contact d'ouverture exploitable, mais il lève
un avertissement : `statusWarning` passe à `2` à l'ouverture du couvercle du
réservoir, et revient à `0` à la fermeture. C'est cette transition `2 -> 0`
qui déclenche l'enregistrement.

Mesuré sur un RIKA Sumo, poêle sous tension, avec une surveillance continue :

```
23:33:10  ETAT INITIAL  Cover=true Door=true ... Warning=0
23:35:45  CHANGEMENT    statusWarning: 0 -> 2      <- ouverture du couvercle
```

Aucun des contacts (`inputCover`, `inputDoor`, `inputGridContact`,
`inputBurnBackFlapSwitch`, `inputFlueGasFlapSwitch`, `inputPressureSwitch`)
n'a bougé pendant cette ouverture : ils ne sont pas exploitables, seul le code
d'avertissement l'est.

**Deux limites à connaître :**

- **Le poêle doit être sous tension.** Éteint, il ne remonte aucun
  avertissement, donc un plein fait à froid n'est pas détecté. L'interrupteur
  manuel reste là pour ces cas.
- **Fenêtre de sondage de 60 secondes** (`updateInterval`) : une ouverture et
  une fermeture toutes deux comprises entre deux relevés passent inaperçues.
  Un remplissage réel prend plus longtemps, mais un simple coup d'œil rapide
  peut échapper à la détection — ce qui est plutôt souhaitable ici.

**Le code 2 est spécifique au couvercle du réservoir.** Vérifié en ouvrant la
porte du foyer, poêle sous tension, sur quatre relevés en 24 secondes :

```
Warning=0  Error=0  SubError=0  Service=0
```

La porte du foyer ne lève aucun avertissement : nettoyer le foyer ne peut donc
pas être pris pour un plein. Et seul le code configuré dans
`refillWarningCode` déclenche la détection — tout autre avertissement, ou
toute erreur, est ignoré.

### Codes `statusWarning` identifiés sur un RIKA Sumo

| Code | Signification | Comment il a été établi |
|---|---|---|
| `0` | rien à signaler | état de repos, y compris porte du foyer ouverte |
| `2` | couvercle du réservoir ouvert | surveillance continue pendant une ouverture |

Les autres codes ne sont pas documentés par RIKA. Le journal Homebridge
affiche la valeur brute à chaque apparition, à rapprocher de la notice.

### Options

| Option | Défaut | Description |
|---|---|---|
| `hopperCapacityKg` | `40` | Capacité du réservoir plein, en kg |
| `lowPelletThresholdPercent` | `20` | Seuil de l'alerte de niveau bas |
| `autoDetectRefill` | `true` | Détection des pleins via l'avertissement du poêle |
| `refillWarningCode` | `2` | Code `statusWarning` du couvercle ouvert |
| `refillSwitch` | `true` | Interrupteur manuel dans HomeKit |

### Limites à connaître

- **Résolution de 1 kg** : le compteur du poêle est entier.
- **Le premier démarrage suppose le réservoir plein.** Si ce n'est pas le cas,
  faites un vrai plein puis actionnez l'interrupteur.
- Si le compteur du poêle repart en arrière (remise à zéro lors d'un entretien),
  le plugin le détecte et se réancre en supposant le réservoir plein.
- L'état est conservé dans `rika-pellets-<stoveID>.json`, dans le dossier de
  stockage Homebridge, et survit donc aux redémarrages.

### Autres données disponibles

L'API FireNet expose aussi, non exploitées par le plugin pour l'instant :
`parameterFeedRateService` (kg depuis l'entretien), `parameterServiceCountdownKg`
(kg avant le prochain grand nettoyage), `parameterRuntimePellets` (heures de
fonctionnement) et `parameterIgnitionCount` (nombre d'allumages).

## Santé du poêle

Deux indicateurs exposés dans HomeKit, pensés pour être **actionnables** plutôt
que consultables : ils déclenchent une automatisation ou une notification.

### Entretien à échéance

Le poêle décompte lui-même les kilos de pellets restants avant son grand
nettoyage (`parameterServiceCountdownKg`, sur un intervalle
`parameterKgTillCleaning`). C'est présenté comme un **filtre** :
`FilterLifeLevel` donne le pourcentage restant, et `FilterChangeIndication`
passe à « à remplacer » sous le seuil `serviceAlertKg`.

### Défaut actif

Un **contact** qui s'ouvre dès que le poêle signale quelque chose :
`statusError`, `statusSubError` ou `statusWarning` non nul. Le type contact est
le plus exploitable en automatisation dans l'app Maison. Le détail des codes
est écrit dans le journal Homebridge à chaque apparition et à chaque
résolution. Le thermostat porte en plus `StatusFault`.

Les codes ne sont pas traduits en texte : la correspondance n'est pas publiée
par RIKA. Le journal donne les valeurs brutes, à rapprocher de la notice.

### Options

| Option | Défaut | Description |
|---|---|---|
| `healthSensors` | `true` | Expose les deux indicateurs |
| `serviceAlertKg` | `25` | Seuil d'alerte d'entretien, en kg restants |

### Autres données disponibles, non exposées

`parameterRuntimePellets` (heures de fonctionnement),
`parameterIgnitionCount` (allumages), `parameterOnOffCycleCount`,
`parameterErrorCount0` à `19` (compteurs cumulés par type d'erreur),
`statusWifiStrength`, `inputFlameTemperature`, `inputCurrentStage`.

Le comportement de `inputCover` reste inexpliqué : observé à `true` poêle
éteint, à `false` poêle sous tension, puis de nouveau à `true` sans changement
d'état, et immobile pendant une ouverture confirmée du couvercle. Ne pas
s'appuyer sur ce champ — c'est `statusWarning` qui porte l'information.

## Accessoires publiés

Le plugin publie **cinq accessoires distincts**, et non un seul portant
plusieurs services. C'est indispensable : Apple Home réduit un accessoire
ponté à une tuile unique, celle de son service principal, et **n'affiche pas**
les services secondaires (`Battery`, `FilterMaintenance`, `ContactSensor`,
`Switch`). Regroupés, tous les indicateurs sauf le thermostat étaient
invisibles.

| Accessoire | Service | Ce qu'Apple Home montre |
|---|---|---|
| `Poele` | `Thermostat` + `StatusFault` | température, consigne, marche/arrêt |
| `Poele pellets` | `HumiditySensor` + `Battery` | pourcentage de pellets restants |
| `Poele plein` | `Switch` | interrupteur d'enregistrement du plein |
| `Poele entretien` | `ContactSensor` + `FilterMaintenance` | ouvert = entretien à faire |
| `Poele défaut` | `ContactSensor` | ouvert = le poêle signale un défaut |

### Pourquoi un capteur d'humidité pour les pellets

Apple Home ne crée aucune tuile pour un service `Battery` seul, et n'affiche
un pourcentage que pour quelques types de capteurs. Le capteur d'humidité est
le seul qui présente une valeur en pourcentage dans une tuile lisible. Le
libellé est donc trompeur — la tuile parlera d'humidité — mais la valeur
affichée est bien le niveau de pellets. Le service `Battery` est conservé sur
le même accessoire pour l'alerte de niveau bas et pour les applications qui
l'affichent correctement, comme Eve.

### Identifiants stables

Chaque accessoire dérive son UUID de `stoveID` et de son rôle. Redémarrer
Homebridge ou mettre le plugin à jour ne recrée donc pas les accessoires :
leurs pièces et leurs automatisations sont conservées.

## Modèles

Tout poêle RIKA doté d'un module FireNet devrait fonctionner.

Testés : RIKA Livo (amont), RIKA Corso (ce fork).

## Débogage

Les messages de routine sont en niveau `debug`. Pour les voir, lancez
Homebridge en mode debug (`-D`), ou activez *Debug Mode* dans les réglages de
l'interface Homebridge.

## Licence

GNU GPLv3 — voir [LICENSE](LICENSE). Copyright (C) 2025 Maël Laroque, avec les
modifications de ce fork.
