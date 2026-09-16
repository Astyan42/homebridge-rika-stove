# homebridge-rika-corso

Plugin [Homebridge](https://homebridge.io) pour piloter un poêle RIKA équipé
d'un module FireNet, exposé dans HomeKit comme un thermostat. Il couvre le
« mode Confort » du poêle : allumage/extinction et température de consigne.

> **Fork.** Version d'origine : `homebridge-rika-corso@1.0.5` de
> Maël Laroque ([@mael50](https://www.npmjs.com/~zaki_mael)), publiée le
> 31 octobre 2025. Aucun dépôt public n'étant déclaré dans les métadonnées npm,
> ce dépôt repart du tarball npm. Licence GNU GPLv3 conservée.

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

En éditant `config.json` à la main, l'accessoire se déclare dans le tableau
`accessories` :

```json
{
  "accessories": [
    {
      "accessory": "RIKAFirenet",
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
| `accessory` | oui | — | Doit valoir exactement `RIKAFirenet` |
| `name` | oui | — | Nom affiché dans l'app Maison |
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

### Détection automatique (expérimental, désactivé par défaut)

Le plugin sait aussi enregistrer un plein quand le contact `inputCover`
repasse de `false` à `true`. **Cette détection a été testée sans succès sur un
RIKA Sumo** : couvercle physiquement ouvert, `inputCover` reste à `true`, sur
six relevés en trente secondes avec `lastSeenMinutes: 0`. Les contacts
`inputDoor`, `inputGridContact`, `inputBurnBackFlapSwitch`,
`inputFlueGasFlapSwitch` et `inputPressureSwitch` ne bougent pas davantage.

Ces contacts ne semblent donc pas refléter l'état physique dans la charge utile
du cloud, au moins poêle à l'arrêt. L'option `autoDetectRefill` est laissée
en place, à `false` par défaut : ne l'activez que si vous avez vérifié que votre
modèle remonte bien ce contact. Pour le vérifier, ouvrez le couvercle et
laissez-le ouvert, puis comparez deux relevés de `/api/client/<stoveID>/status`.

Une piste non explorée : ces contacts sont peut-être rafraîchis uniquement
lorsque le poêle fonctionne.

### Options

| Option | Défaut | Description |
|---|---|---|
| `hopperCapacityKg` | `40` | Capacité du réservoir plein, en kg |
| `lowPelletThresholdPercent` | `20` | Seuil de l'alerte de niveau bas |
| `autoDetectRefill` | `false` | Détection via le couvercle — expérimental, voir ci-dessus |
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

## Caractéristiques HomeKit exposées

Le poêle est présenté comme un `Thermostat` :

- `CurrentHeatingCoolingState` — OFF / HEAT
- `TargetHeatingCoolingState` — OFF / HEAT
- `CurrentTemperature` — température ambiante mesurée par le poêle
- `TargetTemperature` — consigne du mode Confort, de 14 à 28 °C
- `TemperatureDisplayUnits` — Celsius

Plus un service `Battery` (`BatteryLevel`, `StatusLowBattery`) pour le niveau de
pellets, et un `Switch` « plein » si `refillSwitch` est actif.

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
