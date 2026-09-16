'use strict'

// homebridge-rika-corso — pilotage des poêles RIKA Corso via le cloud FireNet.
//
// Copyright (C) 2025 Maël Laroque (@mael50)
// Fork maintenu par Jérémy Deveaux.
//
// Ce programme est un logiciel libre sous licence GNU GPLv3. Voir LICENSE.

let Service, Characteristic

const BASE_URL = 'https://www.rika-firenet.com'
const LOGIN_URL = `${BASE_URL}/web/login`
const DEFAULT_TIMEOUT = 10000
const DEFAULT_UPDATE_INTERVAL = 60000
const CACHE_TTL = 5000
const RELOGIN_DELAY = 30000
const CONFIRM_DELAY = 2000

module.exports = (homebridge) => {
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  homebridge.registerAccessory('RIKAFirenet', RIKAFirenetAccessory)
}

class RIKAFirenetAccessory {
  constructor (log, config) {
    this.log = log
    this.config = config

    // Valeurs par défaut
    this.CurrentHeatingCoolingState = 0 // OFF, HEAT, COOL (0, 1, 2)
    this.TargetHeatingCoolingState = 0 // OFF, HEAT, COOL, AUTO (0, 1, 2, 3)
    this.CurrentTemperature = 20
    this.TargetTemperature = 20

    this.latestUpdateTimestamp = 0
    this.connected = false

    // Session HTTP : remplace le cookie jar de `request`
    this.cookies = new Map()
    // Mise à jour en vol, partagée par tous les appelants simultanés
    this.updateInFlight = null

    // Stockage des contrôles complets pour les mises à jour
    this.currentControls = null

    this.timeout = this.config.timeout || DEFAULT_TIMEOUT
    this.updateInterval = this.config.updateInterval || DEFAULT_UPDATE_INTERVAL

    this.loginToFirenet(() => {
      this.updateStatus()
      // Démarrer les mises à jour périodiques
      this.startPeriodicUpdates()
    })

    // Utilisation d'un Thermostat pour avoir les contrôles de température
    this.service = new Service.Thermostat(this.config.name)
  }

  getServices () {
    const informationService = new Service.AccessoryInformation()
        .setCharacteristic(Characteristic.Manufacturer, 'RIKA')
        .setCharacteristic(Characteristic.Model, 'Firenet')
        .setCharacteristic(Characteristic.SerialNumber, this.config.stoveID || '0000000000')

    // Configuration des caractéristiques du thermostat
    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
        .on('get', this.getCharacteristic.bind(this, 'CurrentHeatingCoolingState'))
        .setProps({
          maxValue: 2,
          minValue: 0,
          validValues: [0, 1, 2] // OFF, HEAT, COOL
        })

    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .on('get', this.getCharacteristic.bind(this, 'TargetHeatingCoolingState'))
        .on('set', this.setTargetHeatingCoolingState.bind(this))
        .setProps({
          maxValue: 1,
          minValue: 0,
          validValues: [0, 1] // OFF, HEAT seulement (pas de COOL ni AUTO)
        })

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
        .on('get', this.getCharacteristic.bind(this, 'CurrentTemperature'))
        .setProps({
          minValue: -50,
          maxValue: 100,
          minStep: 0.1
        })

    this.service.getCharacteristic(Characteristic.TargetTemperature)
        .on('get', this.getCharacteristic.bind(this, 'TargetTemperature'))
        .on('set', this.setTargetTemperature.bind(this))
        .setProps({
          minValue: 14,
          maxValue: 28,
          minStep: 1
        })

    // Unités de température en Celsius
    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
        .on('get', (callback) => callback(null, Characteristic.TemperatureDisplayUnits.CELSIUS))
        .on('set', (value, callback) => callback(null))

    return [informationService, this.service]
  }

  // ---------------------------------------------------------------------------
  // Couche HTTP : fetch natif + gestion manuelle des cookies de session.
  // `request` (abandonné depuis 2020) apportait à lui seul 6 vulnérabilités
  // sans correctif disponible. Node >= 20 fournit tout ce qu'il faut.
  // ---------------------------------------------------------------------------

  storeCookies (response) {
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : []

    for (const line of raw) {
      const pair = line.split(';')[0]
      const sep = pair.indexOf('=')
      if (sep > 0) {
        this.cookies.set(pair.slice(0, sep).trim(), pair.slice(sep + 1).trim())
      }
    }
  }

  cookieHeader () {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join('; ')
  }

  async httpRequest (url, options = {}) {
    const headers = Object.assign({}, options.headers)
    const cookie = this.cookieHeader()
    if (cookie) {
      headers.Cookie = cookie
    }

    const response = await fetch(url, Object.assign({}, options, {
      headers,
      signal: AbortSignal.timeout(this.timeout)
    }))

    // Y compris sur une redirection : c'est là que FireNet pose la session.
    this.storeCookies(response)
    return response
  }

  async getJson (path) {
    const response = await this.httpRequest(`${BASE_URL}${path}`)
    let body = null
    if (response.status === 200) {
      try {
        body = await response.json()
      } catch (parseError) {
        this.log('Erreur lors du traitement des données:', parseError.message)
      }
    }
    return { status: response.status, body }
  }

  // ---------------------------------------------------------------------------

  startPeriodicUpdates () {
    if (this.updateTimer) {
      clearInterval(this.updateTimer)
    }

    this.updateTimer = setInterval(() => {
      this.log.debug('Mise à jour périodique...')
      this.updateStatus()
    }, this.updateInterval)
  }

  setTargetHeatingCoolingState (value, callback) {
    this.log(`Changement de mode: ${value === 0 ? 'OFF' : value === 1 ? 'HEAT' : 'AUTO'}`)
    this.TargetHeatingCoolingState = value

    // Si on met sur OFF, éteindre le poêle
    if (value === 0) {
      this.updateCharacteristic('onOff', false, callback)
    } else {
      // Si on met sur HEAT ou AUTO, allumer le poêle
      this.updateCharacteristic('onOff', true, callback)
    }
  }

  setTargetTemperature (value, callback) {
    this.log(`Température cible mode confort: ${value}°C`)
    this.TargetTemperature = value
    this.updateCharacteristic('targetTemperature', value, callback)
  }

  loginToFirenet (onSuccess) {
    this.log('Connexion à Firenet...')

    const loginData = new URLSearchParams({
      email: this.config.FirenetEmail,
      password: this.config.FirenetPassword
    })

    // `redirect: 'manual'` est indispensable : fetch n'expose pas les en-têtes
    // des réponses intermédiaires, or la session arrive sur la redirection 302.
    this.httpRequest(LOGIN_URL, {
      method: 'POST',
      body: loginData,
      redirect: 'manual'
    }).then(async (response) => {
      const location = response.headers.get('location') || ''
      const redirected = response.status >= 300 && response.status < 400

      let success = redirected && location.includes('summary')
      if (!success && response.status === 200) {
        // Certaines réponses renvoient directement la page de résumé.
        const body = await response.text()
        success = body.includes('summary')
      }

      if (success) {
        this.log('✓ Connecté à Firenet')
        this.connected = true
        if (typeof onSuccess === 'function') {
          onSuccess()
        }
      } else {
        this.log('✗ Échec de connexion à Firenet - Vérifiez vos identifiants')
        this.connected = false
      }
    }).catch((error) => {
      this.log('Erreur de connexion:', error.message)
      this.connected = false
      // Réessayer après 30 secondes
      setTimeout(() => this.loginToFirenet(onSuccess), RELOGIN_DELAY)
    })
  }

  // Une seule requête en vol : les appelants simultanés partagent la même.
  updateStatus () {
    if (!this.updateInFlight) {
      this.updateInFlight = this.fetchStatus().finally(() => {
        this.updateInFlight = null
      })
    }
    return this.updateInFlight
  }

  async fetchStatus () {
    this.log.debug('Mise à jour du statut...')

    let result
    try {
      result = await this.getJson(`/api/client/${this.config.stoveID}/status`)
    } catch (error) {
      this.log('Erreur lors de la récupération du statut:', error.message)
      return
    }

    const { status, body } = result

    if (status === 200 && body && body.stoveID === this.config.stoveID) {
      try {
        // Sauvegarde des contrôles complets pour les futures mises à jour
        this.currentControls = body.controls

        // Mise à jour des températures
        this.TargetTemperature = body.controls.targetTemperature
        this.CurrentTemperature = body.sensors.inputRoomTemperature
        this.revision = body.controls.revision

        // Détermination de l'état du chauffage
        const mainState = body.sensors.statusMainState
        const subState = body.sensors.statusSubState
        const isOn = body.controls.onOff === true

        this.log.debug(`États: mainState=${mainState}, subState=${subState}, onOff=${isOn}`)

        // Définir CurrentHeatingCoolingState (ce que fait le poêle actuellement)
        if (!isOn || (mainState === 0 && subState === 1)) {
          this.CurrentHeatingCoolingState = 0 // OFF
        } else if (mainState >= 2 && mainState <= 5) {
          this.CurrentHeatingCoolingState = 1 // HEATING
        } else {
          this.CurrentHeatingCoolingState = 1 // IDLE mais allumé = HEATING
        }

        // Définir TargetHeatingCoolingState (ce que veut l'utilisateur)
        this.TargetHeatingCoolingState = isOn ? 1 : 0 // HEAT ou OFF

        this.latestUpdateTimestamp = Date.now()
        this.log.debug(`✓ Statut mis à jour - Temp: ${this.CurrentTemperature}°C / Cible: ${this.TargetTemperature}°C / État: ${isOn ? 'ON' : 'OFF'}`)

        // Mise à jour des valeurs dans HomeKit
        this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(this.CurrentHeatingCoolingState)
        this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(this.TargetHeatingCoolingState)
        this.service.getCharacteristic(Characteristic.CurrentTemperature).updateValue(this.CurrentTemperature)
        this.service.getCharacteristic(Characteristic.TargetTemperature).updateValue(this.TargetTemperature)
      } catch (parseError) {
        this.log('Erreur lors du traitement des données:', parseError.message)
      }
    } else if (status === 401) {
      this.log('Session expirée, reconnexion...')
      this.loginToFirenet(() => this.updateStatus())
    } else if (status === 500) {
      this.log('Erreur serveur Firenet - Le poêle est-il lié à ce compte?')
    } else {
      this.log(`Erreur inattendue: ${status}`)
    }
  }

  getCharacteristic (characteristic, callback) {
    const cacheAge = Date.now() - this.latestUpdateTimestamp

    if (cacheAge <= CACHE_TTL) {
      this.log.debug(`→ Récupération depuis le cache: ${characteristic} = ${this[characteristic]}`)
      callback(null, this[characteristic])
      return
    }

    this.log.debug(`→ Récupération depuis le serveur: ${characteristic}`)
    // On répond toujours, même en cas d'échec : servir la dernière valeur connue
    // vaut mieux que laisser HomeKit afficher « Pas de réponse ».
    this.updateStatus().finally(() => {
      callback(null, this[characteristic])
    })
  }

  async updateCharacteristic (controlItem, value, callback) {
    this.log(`Envoi de la mise à jour: ${controlItem} = ${value}`)

    let result
    try {
      // D'abord récupérer le statut actuel pour avoir tous les paramètres
      result = await this.getJson(`/api/client/${this.config.stoveID}/status`)
    } catch (error) {
      this.log('Erreur lors de la récupération du statut:', error.message)
      callback(error)
      return
    }

    const { status, body } = result

    if (status === 401) {
      this.log('Session expirée, reconnexion...')
      this.loginToFirenet(() => this.updateCharacteristic(controlItem, value, callback))
      return
    }

    if (status === 500) {
      this.log('Erreur serveur Firenet')
      callback(new Error('Firenet server error'))
      return
    }

    if (status !== 200 || !body || body.stoveID !== this.config.stoveID) {
      this.log(`Erreur inattendue: ${status}`)
      callback(new Error(`Unexpected response ${status}`))
      return
    }

    try {
      // Préparer les données à envoyer avec TOUS les paramètres
      const controls = body.controls

      // Modifier uniquement le paramètre souhaité
      controls[controlItem] = value

      // Préparer les données au format application/x-www-form-urlencoded
      const formData = {
        operatingMode: controls.operatingMode,
        heatingPower: controls.heatingPower,
        targetTemperature: controls.targetTemperature,
        bakeTemperature: controls.bakeTemperature,
        onOff: controls.onOff,
        heatingTimesActiveForComfort: controls.heatingTimesActiveForComfort,
        setBackTemperature: controls.setBackTemperature,
        convectionFan1Active: controls.convectionFan1Active,
        convectionFan1Level: controls.convectionFan1Level,
        convectionFan1Area: controls.convectionFan1Area,
        convectionFan2Active: controls.convectionFan2Active,
        convectionFan2Level: controls.convectionFan2Level,
        convectionFan2Area: controls.convectionFan2Area,
        frostProtectionActive: controls.frostProtectionActive,
        frostProtectionTemperature: controls.frostProtectionTemperature,
        revision: controls.revision
      }

      this.log.debug(`Données envoyées: ${JSON.stringify(formData)}`)

      const response = await this.httpRequest(`${BASE_URL}/api/client/${this.config.stoveID}/controls`, {
        method: 'POST',
        body: new URLSearchParams(formData),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest'
        }
      })

      if (response.status === 200) {
        this.log(`✓ ${controlItem} défini sur: ${value}`)
        // Forcer une mise à jour après 2 secondes pour vérifier le changement
        setTimeout(() => this.updateStatus(), CONFIRM_DELAY)
        callback(null)
      } else {
        const text = await response.text().catch(() => '')
        this.log(`✗ Échec de la mise à jour de ${controlItem}: ${response.status} - ${text}`)
        callback(new Error(`Failed to update ${controlItem}`))
      }
    } catch (error) {
      this.log("Erreur lors de l'envoi de la commande:", error.message)
      callback(error)
    }
  }
}
