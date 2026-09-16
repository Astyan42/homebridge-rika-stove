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

## Caractéristiques HomeKit exposées

Le poêle est présenté comme un `Thermostat` :

- `CurrentHeatingCoolingState` — OFF / HEAT
- `TargetHeatingCoolingState` — OFF / HEAT
- `CurrentTemperature` — température ambiante mesurée par le poêle
- `TargetTemperature` — consigne du mode Confort, de 14 à 28 °C
- `TemperatureDisplayUnits` — Celsius

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
