#!/usr/bin/env node
// Lecture seule : affiche la programmation horaire du poêle telle que l'API la
// renvoie. Aucun réglage n'est modifié et aucun identifiant n'est affiché.
//
//   node tools/lire-plages.mjs [chemin/config.json]
//
// Par défaut, lit la configuration Homebridge du Raspberry.

import fs from 'node:fs'

const CONFIG = process.argv[2] || '/var/lib/homebridge/config.json'
const BASE = 'https://www.rika-firenet.com'

const conf = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
const platform = (conf.platforms || []).find((p) => p.platform === 'RIKAFirenet')
if (!platform) {
  console.error(`Aucune plateforme RIKAFirenet dans ${CONFIG}`)
  process.exit(2)
}

const reponse = await fetch(`${BASE}/web/login`, {
  method: 'POST',
  body: new URLSearchParams({
    email: platform.FirenetEmail,
    password: platform.FirenetPassword
  }),
  redirect: 'manual'
})

const cookies = (reponse.headers.getSetCookie() || [])
  .map((c) => c.split(';')[0])
  .join('; ')
const emplacement = reponse.headers.get('location') || ''
if (!(reponse.status >= 300 && reponse.status < 400 && emplacement.includes('summary'))) {
  console.error(`Échec de connexion (HTTP ${reponse.status})`)
  process.exit(1)
}

const etat = await fetch(`${BASE}/api/client/${platform.stoveID}/status`, {
  headers: { cookie: cookies }
})
if (etat.status !== 200) {
  console.error(`Lecture de l'état impossible (HTTP ${etat.status})`)
  process.exit(1)
}

const { controls, sensors } = await etat.json()

console.log('=== PROGRAMMATION ===')
console.log(`heatingTimesActiveForComfort : ${controls.heatingTimesActiveForComfort}`)
const plages = Object.keys(controls).filter((k) => k.startsWith('heatingTime')).sort()
for (const cle of plages) {
  console.log(`  ${cle.padEnd(22)} ${JSON.stringify(controls[cle])}`)
}
if (plages.length === 1) {
  console.log('  (aucun champ de plage horaire : voir la liste complète ci-dessous)')
}

console.log('\n=== REGLAGES COURANTS ===')
for (const cle of ['operatingMode', 'heatingPower', 'targetTemperature',
  'setBackTemperature', 'temperatureOffset', 'ecoMode', 'frostProtectionActive',
  'frostProtectionTemperature', 'revision']) {
  console.log(`  ${cle.padEnd(28)} ${JSON.stringify(controls[cle])}`)
}
console.log(`  sonde                        ${sensors.inputRoomTemperature}`)
console.log(`  état                         ${sensors.statusMainState}/${sensors.statusSubState}`)

console.log('\n=== TOUTES LES CLES DE CONTROLE ===')
console.log(Object.keys(controls).sort().join(', '))
