// Tests de la logique pellets et santé, sans réseau ni HomeKit.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
globalThis.fetch = async () => { throw new Error('réseau désactivé pour le test') }

const { RIKAFirenetPlatform } = require('../index.js')

// --- Stubs HAP minimaux -----------------------------------------------------
const chainable = () => ({
  onGet () { return this }, onSet () { return this }, setProps () { return this },
  updateValue () { return this }, getCharacteristic () { return chainable() },
  setCharacteristic () { return this }
})
const Characteristic = new Proxy({
  TemperatureDisplayUnits: { CELSIUS: 0 },
  ChargingState: { NOT_CHARGEABLE: 2 },
  FilterChangeIndication: { FILTER_OK: 0, CHANGE_FILTER: 1 },
  ContactSensorState: { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 },
  StatusFault: { NO_FAULT: 0, GENERAL_FAULT: 1 }
}, { get: (t, k) => (k in t ? t[k] : String(k)) })

const tmp = fs.mkdtempSync(`${os.tmpdir()}/rika-`)
const messages = []
function makeLog () {
  const log = (...a) => messages.push(a.join(' '))
  log.debug = (...a) => messages.push('[debug] ' + a.join(' '))
  return log
}
function make (config = {}) {
  messages.length = 0
  const api = {
    hap: { Service: {}, Characteristic, uuid: { generate: (s) => s }, Categories: {} },
    user: { storagePath: () => tmp },
    on: () => {}
  }
  return new RIKAFirenetPlatform(makeLog(), {
    name: 'Poele', stoveID: 'TEST', FirenetEmail: 'a@b.c', FirenetPassword: 'x', ...config
  }, api)
}
// warning = code d'avertissement du poêle (2 = couvercle du réservoir ouvert)
const sensors = (total, warning = 0) => ({ parameterFeedRateTotal: total, statusWarning: warning })
const health = (countdown, interval = 700, error = 0, subError = 0, warning = 0) => ({
  parameterServiceCountdownKg: countdown, parameterKgTillCleaning: interval,
  statusError: error, statusSubError: subError, statusWarning: warning
})
const reset = () => fs.rmSync(`${tmp}/rika-pellets-TEST.json`, { force: true })

let passed = 0
function check (label, fn) {
  try { fn(); console.log(`  OK   ${label}`); passed++ }
  catch (e) { console.log(`  ECHEC ${label}\n        ${e.message}`); process.exitCode = 1 }
}

console.log('=== ANCRAGE INITIAL ===')
reset()
check('premier relevé : réservoir supposé plein à 100 %', () => {
  const a = make({ hopperCapacityKg: 40 })
  a.updatePelletLevel(sensors(2072))
  assert.equal(a.pelletLevelPercent, 100)
  assert.equal(a.pelletsRemainingKg, 40)
  assert.equal(a.pelletState.feedRateTotalAtRefill, 2072)
})

console.log('\n=== CONSOMMATION ===')
check('10 kg consommés sur 40 -> 75 %', () => {
  const a = make({ hopperCapacityKg: 40 })
  a.updatePelletLevel(sensors(2072)); a.updatePelletLevel(sensors(2082))
  assert.equal(a.pelletsRemainingKg, 30); assert.equal(a.pelletLevelPercent, 75)
})
check('réservoir vidé -> 0 %, jamais négatif', () => {
  const a = make({ hopperCapacityKg: 40 })
  a.updatePelletLevel(sensors(2072)); a.updatePelletLevel(sensors(2200))
  assert.equal(a.pelletsRemainingKg, 0); assert.equal(a.pelletLevelPercent, 0)
})

console.log('\n=== SEUIL BAS ===')
check('alerte au franchissement du seuil, une seule fois', () => {
  const a = make({ hopperCapacityKg: 40, lowPelletThresholdPercent: 20 })
  a.updatePelletLevel(sensors(2072))
  a.updatePelletLevel(sensors(2100))
  assert.equal(messages.filter(m => m.includes('bas')).length, 0)
  a.updatePelletLevel(sensors(2105))
  assert.equal(messages.filter(m => m.includes('bas')).length, 1)
  a.updatePelletLevel(sensors(2106))
  assert.equal(messages.filter(m => m.includes('bas')).length, 1, 'ne doit pas répéter')
})

console.log("\n=== DETECTION DU PLEIN PAR LE CODE D'AVERTISSEMENT ===")
check('avertissement 2 puis retour à 0 -> plein enregistré', () => {
  reset()
  const a = make({ hopperCapacityKg: 40 })
  a.updatePelletLevel(sensors(2072)); a.updatePelletLevel(sensors(2100))
  assert.equal(a.pelletLevelPercent, 30)
  a.updatePelletLevel(sensors(2100, 2))
  a.updatePelletLevel(sensors(2100, 0))
  assert.equal(a.pelletLevelPercent, 100)
  assert.equal(a.pelletState.feedRateTotalAtRefill, 2100)
})
check('avertissement toujours à 0 -> aucun plein', () => {
  reset()
  const a = make({ hopperCapacityKg: 40 })
  a.updatePelletLevel(sensors(2072)); a.updatePelletLevel(sensors(2092))
  assert.equal(a.pelletLevelPercent, 50)
})
check('couvercle encore ouvert -> pas de plein prématuré', () => {
  reset()
  const a = make({ hopperCapacityKg: 40 })
  a.updatePelletLevel(sensors(2072)); a.updatePelletLevel(sensors(2092))
  a.updatePelletLevel(sensors(2092, 2))
  assert.equal(a.pelletLevelPercent, 50, "le plein ne compte qu'à la fermeture")
})
check("autre code d'avertissement -> ignoré", () => {
  reset()
  const a = make({ hopperCapacityKg: 40 })
  a.updatePelletLevel(sensors(2072)); a.updatePelletLevel(sensors(2092))
  a.updatePelletLevel(sensors(2092, 7)); a.updatePelletLevel(sensors(2092, 0))
  assert.equal(a.pelletLevelPercent, 50, 'seul le code du couvercle compte')
})
check('code personnalisable via refillWarningCode', () => {
  reset()
  const a = make({ hopperCapacityKg: 40, refillWarningCode: 9 })
  a.updatePelletLevel(sensors(2072)); a.updatePelletLevel(sensors(2092))
  a.updatePelletLevel(sensors(2092, 9)); a.updatePelletLevel(sensors(2092, 0))
  assert.equal(a.pelletLevelPercent, 100)
})
check('autoDetectRefill: false -> aucune détection', () => {
  reset()
  const a = make({ hopperCapacityKg: 40, autoDetectRefill: false })
  a.updatePelletLevel(sensors(2072)); a.updatePelletLevel(sensors(2092))
  a.updatePelletLevel(sensors(2092, 2)); a.updatePelletLevel(sensors(2092, 0))
  assert.equal(a.pelletLevelPercent, 50)
})

console.log('\n=== COMPTEUR DU POELE REMIS A ZERO (entretien) ===')
check('compteur en arrière -> réancrage sans valeur négative', () => {
  reset()
  const a = make({ hopperCapacityKg: 40 })
  a.updatePelletLevel(sensors(2072)); a.updatePelletLevel(sensors(5))
  assert.equal(a.pelletLevelPercent, 100)
  assert.equal(a.pelletState.feedRateTotalAtRefill, 5)
  assert.ok(messages.some(m => m.includes('arrière')), 'doit le signaler')
})

console.log('\n=== PERSISTANCE ===')
check('état rechargé après redémarrage', () => {
  reset()
  const a = make({ hopperCapacityKg: 40 })
  a.updatePelletLevel(sensors(2072)); a.updatePelletLevel(sensors(2082))
  assert.equal(a.pelletLevelPercent, 75)
  const b = make({ hopperCapacityKg: 40 })
  assert.equal(b.pelletState.feedRateTotalAtRefill, 2072, 'ancre relue du disque')
  b.updatePelletLevel(sensors(2082))
  assert.equal(b.pelletLevelPercent, 75, 'niveau retrouvé, pas remis à 100')
})
check("fichier d'état en permissions 600", () => {
  assert.equal((fs.statSync(`${tmp}/rika-pellets-TEST.json`).mode & 0o777).toString(8), '600')
})

console.log('\n=== DONNEES ABERRANTES ===')
check('compteur absent -> aucune exception, niveau inchangé', () => {
  const a = make({ hopperCapacityKg: 40 })
  a.updatePelletLevel(sensors(2072))
  const before = a.pelletLevelPercent
  a.updatePelletLevel({ statusWarning: 0 })
  a.updatePelletLevel({ parameterFeedRateTotal: null, statusWarning: 0 })
  assert.equal(a.pelletLevelPercent, before)
})

console.log('\n=== CAPACITE PERSONNALISEE ===')
check('capacité 25 kg : 5 kg consommés -> 80 %', () => {
  reset()
  const a = make({ hopperCapacityKg: 25 })
  a.updatePelletLevel(sensors(1000)); a.updatePelletLevel(sensors(1005))
  assert.equal(a.pelletsRemainingKg, 20); assert.equal(a.pelletLevelPercent, 80)
})

console.log('\n=== SANTE : ENTRETIEN ===')
check('entretien loin -> non dû, pourcentage correct', () => {
  const a = make({ serviceAlertKg: 25 })
  a.updateHealth(health(350))
  assert.equal(a.serviceDue, false); assert.equal(a.serviceLifePercent, 50)
})
check('sous le seuil -> entretien dû, alerte émise une fois', () => {
  const a = make({ serviceAlertKg: 25 })
  a.updateHealth(health(350)); a.updateHealth(health(4))
  assert.equal(a.serviceDue, true)
  assert.equal(messages.filter(m => m.includes('Entretien à prévoir')).length, 1)
  a.updateHealth(health(3))
  assert.equal(messages.filter(m => m.includes('Entretien à prévoir')).length, 1, 'ne doit pas répéter')
})
check('compteur réarmé -> entretien effectué signalé', () => {
  const a = make({ serviceAlertKg: 25 })
  a.updateHealth(health(4)); a.updateHealth(health(700))
  assert.equal(a.serviceDue, false)
  assert.ok(messages.some(m => m.includes('Entretien effectué')))
})
check('intervalle nul ou absent -> ignoré sans exception', () => {
  const a = make({})
  a.updateHealth({ parameterServiceCountdownKg: 4, parameterKgTillCleaning: 0, statusError: 0 })
  assert.equal(a.serviceCountdownKg, null)
})

console.log('\n=== SANTE : DEFAUT ===')
check('tout à zéro -> aucun défaut', () => {
  const a = make({}); a.updateHealth(health(350)); assert.equal(a.faultActive, false)
})
check('statusWarning non nul -> défaut actif', () => {
  const a = make({})
  a.updateHealth(health(350, 700, 0, 0, 7))
  assert.equal(a.faultActive, true)
  assert.ok(messages.some(m => m.includes('Défaut signalé')))
  assert.ok(a.faultDetail.includes('statusWarning=7'))
})
check('statusError non nul -> défaut actif', () => {
  const a = make({}); a.updateHealth(health(350, 700, 12)); assert.equal(a.faultActive, true)
})
check('défaut qui disparaît -> résolution signalée, une seule alerte', () => {
  const a = make({})
  a.updateHealth(health(350, 700, 0, 0, 7)); a.updateHealth(health(350, 700, 0, 0, 7))
  assert.equal(messages.filter(m => m.includes('Défaut signalé')).length, 1)
  a.updateHealth(health(350))
  assert.ok(messages.some(m => m.includes('Défaut résolu')))
})

console.log('\n=== PLATEFORME : IDENTIFIANTS STABLES ===')
check('un UUID distinct et stable par rôle', () => {
  const a = make({})
  const roles = ['thermostat', 'pellets', 'refill', 'service', 'fault']
  const ids = roles.map(r => a.uuidFor(r))
  assert.equal(new Set(ids).size, 5, 'les cinq rôles doivent différer')
  const b = make({})
  assert.deepEqual(roles.map(r => b.uuidFor(r)), ids, 'stables entre deux instances')
})
check('config incomplète -> refus explicite, pas de crash', () => {
  const a = make({ stoveID: undefined })
  a.start()
  assert.ok(messages.some(m => m.includes('Configuration incomplète')))
})

console.log(`\n${passed} test(s) réussi(s)`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(process.exitCode || 0)
