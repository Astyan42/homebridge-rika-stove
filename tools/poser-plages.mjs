#!/usr/bin/env node
// Pose la programmation horaire du poêle (repli de nuit).
//
//   node tools/poser-plages.mjs --noop    écriture à blanc : renvoie l'objet de
//                                         contrôle inchangé, pour vérifier que
//                                         l'API l'accepte tel quel
//   node tools/poser-plages.mjs           pose les plages ci-dessous
//   node tools/poser-plages.mjs --off     désactive la programmation
//
// Hors des plages de confort, le poêle retombe sur setBackTemperature.
// Format d'une plage : HHMMHHMM (début puis fin). "00000000" = plage inutilisée.

import fs from 'node:fs'

const CONFIG = '/var/lib/homebridge/config.json'
const BASE = 'https://www.rika-firenet.com'
const noop = process.argv.includes('--noop')
const off = process.argv.includes('--off')

// Relance à 04h45 en semaine : la pièce est à ~17,4 °C à 5h, il faut 13 min de
// temps mort puis ~53 min de flamme pour revenir à 20 °C avant le lever à 6h20.
const PLAGES = {
  Mon: ['04452400', '00000000'],
  Tue: ['04452400', '00000000'],
  Wed: ['04452400', '00000000'],
  Thu: ['04452400', '00000000'],
  Fri: ['04452400', '00000000'],
  Sat: ['07002400', '00000000'],
  Sun: ['07002400', '00000000']
}

const conf = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
const platform = (conf.platforms || []).find((p) => p.platform === 'RIKAFirenet')

const connexion = await fetch(`${BASE}/web/login`, {
  method: 'POST',
  body: new URLSearchParams({
    email: platform.FirenetEmail,
    password: platform.FirenetPassword
  }),
  redirect: 'manual'
})
const cookie = (connexion.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ')
if (!(connexion.status >= 300 && connexion.status < 400 &&
      (connexion.headers.get('location') || '').includes('summary'))) {
  console.error(`Échec de connexion (HTTP ${connexion.status})`)
  process.exit(1)
}

const lire = async () => {
  const r = await fetch(`${BASE}/api/client/${platform.stoveID}/status`, { headers: { cookie } })
  if (r.status !== 200) throw new Error(`Lecture impossible (HTTP ${r.status})`)
  return r.json()
}

const avant = (await lire()).controls

// On renvoie l'objet de contrôle complet : l'API remplace tout ce qu'elle reçoit.
const payload = { ...avant }
if (!noop) {
  for (const [jour, [p1, p2]] of Object.entries(PLAGES)) {
    payload[`heatingTime${jour}1`] = off ? '00000000' : p1
    payload[`heatingTime${jour}2`] = off ? '00000000' : p2
  }
  payload.heatingTimesActiveForComfort = !off
}

console.log(noop ? '--- ECRITURE A BLANC (aucune valeur modifiée) ---' : '--- ECRITURE ---')
const envoi = await fetch(`${BASE}/api/client/${platform.stoveID}/controls`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(payload)
})
console.log(`HTTP ${envoi.status}`)
if (envoi.status !== 200) {
  console.error((await envoi.text().catch(() => '')).slice(0, 300))
  process.exit(1)
}

await new Promise((r) => setTimeout(r, 4000))
const apres = (await lire()).controls

console.log('\n=== RELECTURE ===')
console.log(`heatingTimesActiveForComfort : ${apres.heatingTimesActiveForComfort}`)
for (const jour of Object.keys(PLAGES)) {
  console.log(`  ${jour}  ${apres[`heatingTime${jour}1`]}  ${apres[`heatingTime${jour}2`]}`)
}
console.log('\n=== REGLAGES PRESERVES ? ===')
for (const cle of ['targetTemperature', 'setBackTemperature', 'temperatureOffset',
  'heatingPower', 'operatingMode', 'onOff', 'ecoMode', 'frostProtectionTemperature']) {
  const ok = String(avant[cle]) === String(apres[cle]) ? 'OK  ' : 'CHANGE'
  console.log(`  ${ok} ${cle.padEnd(28)} ${JSON.stringify(avant[cle])} -> ${JSON.stringify(apres[cle])}`)
}
