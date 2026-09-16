'use strict'

// homebridge-rika-corso — pilotage des poêles RIKA via le cloud FireNet.
//
// Copyright (C) 2025 Maël Laroque (@mael50)
// Fork maintenu par Jérémy Deveaux.
//
// Ce programme est un logiciel libre sous licence GNU GPLv3. Voir LICENSE.

const fs = require('node:fs')

const PLUGIN_NAME = 'homebridge-rika-stove'
const PLATFORM_NAME = 'RIKAFirenet'

const BASE_URL = 'https://www.rika-firenet.com'
const LOGIN_URL = `${BASE_URL}/web/login`

const DEFAULT_TIMEOUT = 10000
const DEFAULT_UPDATE_INTERVAL = 60000
const RELOGIN_DELAY = 30000
const CONFIRM_DELAY = 2000
const REFILL_SWITCH_RESET_DELAY = 1000
const GAUGE_REVERT_DELAY = 400
const DEFAULT_HOPPER_CAPACITY_KG = 40
const DEFAULT_LOW_PELLET_PERCENT = 20
const DEFAULT_SERVICE_ALERT_KG = 25
// Code d'avertissement du poêle signalant le couvercle du réservoir ouvert.
// Mesuré sur un RIKA Sumo : statusWarning passe de 0 à 2 à l'ouverture, et
// revient à 0 à la fermeture. La porte du foyer ne lève aucun code.
const DEFAULT_REFILL_WARNING_CODE = 2
// Forme des services publiés. À incrémenter dès qu'un service change de
// caractéristiques, de bornes ou de permissions : Homebridge restaure les
// accessoires depuis son cache, et un setProps sur un service restauré n'est
// pas repris. Le service est alors reconstruit une fois, proprement.
const SERVICE_SHAPE = 8

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, RIKAFirenetPlatform)
}

// ---------------------------------------------------------------------------
// Client FireNet : fetch natif, gestion explicite des cookies de session.
// `request` (abandonné depuis 2020) apportait 6 vulnérabilités sans correctif.
// ---------------------------------------------------------------------------

class FirenetClient {
  constructor (log, { email, password, stoveID, timeout }) {
    this.log = log
    this.email = email
    this.password = password
    this.stoveID = stoveID
    this.timeout = timeout || DEFAULT_TIMEOUT
    this.cookies = new Map()
    this.connected = false
  }

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

  async request (url, options = {}) {
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

  login (onSuccess) {
    this.log('Connexion à Firenet...')

    // `redirect: 'manual'` est indispensable : fetch n'expose pas les en-têtes
    // des réponses intermédiaires, or la session arrive sur la redirection 302.
    this.request(LOGIN_URL, {
      method: 'POST',
      body: new URLSearchParams({ email: this.email, password: this.password }),
      redirect: 'manual'
    }).then(async (response) => {
      const location = response.headers.get('location') || ''
      const redirected = response.status >= 300 && response.status < 400

      let success = redirected && location.includes('summary')
      if (!success && response.status === 200) {
        success = (await response.text()).includes('summary')
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
      setTimeout(() => this.login(onSuccess), RELOGIN_DELAY)
    })
  }

  async getStatus () {
    const response = await this.request(`${BASE_URL}/api/client/${this.stoveID}/status`)
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

  async sendControls (formData) {
    return this.request(`${BASE_URL}/api/client/${this.stoveID}/controls`, {
      method: 'POST',
      body: new URLSearchParams(formData),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Plateforme : publie un accessoire distinct par indicateur, afin qu'Apple
// Home leur donne chacun une tuile. Regroupés sur un seul accessoire, les
// services secondaires (Battery, FilterMaintenance, ContactSensor, Switch)
// ne sont pas affichés par Apple Home.
// ---------------------------------------------------------------------------

class RIKAFirenetPlatform {
  constructor (log, config, api) {
    this.log = log
    this.config = config || {}
    this.api = api

    if (!api) {
      return
    }
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic

    this.timeout = Number(this.config.timeout) || DEFAULT_TIMEOUT
    this.updateInterval = Number(this.config.updateInterval) || DEFAULT_UPDATE_INTERVAL
    this.name = this.config.name || 'Poele'

    // --- Poêle (HeaterCooler) ---
    this.Active = 0
    this.CurrentHeaterCoolerState = 0 // INACTIVE / IDLE / HEATING
    this.CurrentTemperature = 20
    this.TargetTemperature = 20
    this.HeatingPower = 70 // puissance de chauffe du poêle, en %
    this.FlameTemperature = 20
    this.currentControls = null
    this.latestUpdateTimestamp = 0
    this.updateInFlight = null

    // --- Pellets ---
    this.hopperCapacityKg = Number(this.config.hopperCapacityKg) || DEFAULT_HOPPER_CAPACITY_KG
    this.lowPelletPercent = Number(this.config.lowPelletThresholdPercent) || DEFAULT_LOW_PELLET_PERCENT
    this.autoDetectRefill = this.config.autoDetectRefill !== false
    this.refillWarningCode = Number.isFinite(Number(this.config.refillWarningCode))
      ? Number(this.config.refillWarningCode)
      : DEFAULT_REFILL_WARNING_CODE
    this.pelletState = { feedRateTotalAtRefill: null, lastRefillAt: null }
    this.lastFeedRateTotal = null
    this.previousWarning = null
    this.pelletsRemainingKg = this.hopperCapacityKg
    this.pelletLevelPercent = 100

    // --- Santé ---
    this.serviceAlertKg = Number(this.config.serviceAlertKg) || DEFAULT_SERVICE_ALERT_KG
    this.healthSensors = this.config.healthSensors !== false
    this.serviceCountdownKg = null
    this.serviceLifePercent = 100
    this.serviceDue = false
    this.flameSensor = this.config.flameSensor === true
    this.flameInCard = this.config.flameInCard !== false
    this.serviceGauge = this.config.serviceGauge !== false
    this.faultActive = false
    this.faultDetail = ''

    this.cached = new Map()
    this.services = {}

    this.loadPelletState()

    this.client = new FirenetClient(log, {
      email: this.config.FirenetEmail,
      password: this.config.FirenetPassword,
      stoveID: this.config.stoveID,
      timeout: this.timeout
    })

    api.on('didFinishLaunching', () => this.start())
  }

  // Restauration des accessoires mis en cache par Homebridge.
  configureAccessory (accessory) {
    this.cached.set(accessory.UUID, accessory)
  }

  start () {
    if (!this.config.stoveID || !this.config.FirenetEmail || !this.config.FirenetPassword) {
      this.log('✗ Configuration incomplète : FirenetEmail, FirenetPassword et stoveID sont requis')
      return
    }
    this.publishAccessories()
    this.client.login(() => {
      this.updateStatus()
      this.startPeriodicUpdates()
    })
  }

  // -------------------------------------------------------------------------
  // Publication des accessoires
  // -------------------------------------------------------------------------

  uuidFor (role) {
    return this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.config.stoveID}:${role}`)
  }

  buildAccessory (role, displayName, category, wanted) {
    const uuid = this.uuidFor(role)
    const existing = this.cached.get(uuid)

    if (!wanted) {
      return { uuid, accessory: existing, unwanted: true }
    }

    if (existing) {
      existing.displayName = displayName
      return { uuid, accessory: existing, isNew: false }
    }

    const accessory = new this.api.platformAccessory(displayName, uuid, category)
    return { uuid, accessory, isNew: true }
  }

  describe (accessory, model, role) {
    const info = accessory.getService(this.Service.AccessoryInformation)
    if (info) {
      info.setCharacteristic(this.Characteristic.Manufacturer, 'RIKA')
          .setCharacteristic(this.Characteristic.Model, model)
          .setCharacteristic(this.Characteristic.SerialNumber, `${this.config.stoveID}-${role}`)
    }
  }

  // L'app Maison ignore la caractéristique Name et s'appuie sur ConfiguredName
  // pour étiqueter les blocs d'un accessoire. Sans elle, tous les blocs
  // portent le nom de l'accessoire. Elle n'est pas déclarée optionnelle sur
  // tous les services, d'où l'enregistrement explicite qui évite un
  // avertissement HAP.
  nameService (service, label) {
    const C = this.Characteristic
    if (typeof service.addOptionalCharacteristic === 'function') {
      service.addOptionalCharacteristic(C.ConfiguredName)
    }
    service.setCharacteristic(C.ConfiguredName, label)
    service.setCharacteristic(C.Name, label)
    return service
  }

  // Récupère un service existant ou le crée, sans dupliquer au redémarrage.
  serviceOn (accessory, type, displayName, subtype) {
    if (subtype) {
      return accessory.getServiceById(type, subtype) ||
             accessory.addService(type, displayName, subtype)
    }
    return accessory.getService(type) || accessory.addService(type, displayName)
  }

  publishAccessories () {
    const C = this.Characteristic
    const Cat = this.api.hap.Categories
    const created = []
    const removed = []

    // --- 1. Le poêle : HeaterCooler ------------------------------------
    // Apple Home donne à ce service une tuile riche — mode, température et
    // curseur de puissance dans la même vue — là où Thermostat n'offre que
    // la température. Le service Battery y ajoute le niveau de pellets.
    const heater = this.buildAccessory('thermostat', this.name, Cat.AIR_HEATER, true)
    heater.accessory.category = Cat.AIR_HEATER
    this.describe(heater.accessory, 'Firenet', 'thermostat')

    // Migration depuis les versions < 2.1 qui exposaient un Thermostat.
    const legacy = heater.accessory.getService(this.Service.Thermostat)
    if (legacy) {
      heater.accessory.removeService(legacy)
      this.log('Service Thermostat remplacé par HeaterCooler')
    }

    // Un service restauré conserve les bornes et permissions du cache. S'il
    // date d'une forme antérieure, on le reconstruit au lieu de le corriger.
    const stale = heater.accessory.getService(this.Service.HeaterCooler)
    if (stale && heater.accessory.context.serviceShape !== SERVICE_SHAPE) {
      heater.accessory.removeService(stale)
      this.log(`Service HeaterCooler reconstruit (forme ${heater.accessory.context.serviceShape || '?'} -> ${SERVICE_SHAPE})`)
    }
    heater.accessory.context.serviceShape = SERVICE_SHAPE

    const h = this.serviceOn(heater.accessory, this.Service.HeaterCooler, this.name)

    h.getCharacteristic(C.Active)
        .onGet(() => this.readCharacteristic('Active'))
        .onSet((value) => this.setActive(value))
    h.getCharacteristic(C.CurrentHeaterCoolerState)
        .onGet(() => this.readCharacteristic('CurrentHeaterCoolerState'))
    // Le poêle ne sait que chauffer : un seul mode proposé.
    h.getCharacteristic(C.TargetHeaterCoolerState)
        .setProps({ validValues: [C.TargetHeaterCoolerState.HEAT] })
        .onGet(() => C.TargetHeaterCoolerState.HEAT)
        .onSet(() => {})
    h.getCharacteristic(C.CurrentTemperature)
        .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
        .onGet(() => this.readCharacteristic('CurrentTemperature'))

    const threshold = h.getCharacteristic(C.HeatingThresholdTemperature)
    threshold.setProps({ minValue: 14, maxValue: 28, minStep: 1 })
    threshold.updateValue(this.TargetTemperature)
    threshold.onGet(() => this.readCharacteristic('TargetTemperature'))
             .onSet((value) => this.setTargetTemperature(value))

    // Le niveau de pellets, porté par un service ventilateur distinct. C'est
    // la structure qu'emploient les climatiseurs : Apple Home leur donne un
    // bloc de contrôle propre, en bas de la fiche de l'accessoire. Accrochée
    // au HeaterCooler, la même caractéristique était reléguée dans la
    // sous-page des réglages.
    const gauge = this.serviceOn(heater.accessory, this.Service.Fanv2, `${this.name} pellets`, 'pellets')
    this.nameService(gauge, this.config.pelletGaugeName || 'Pellets')

    // Le bloc doit être actif pour que sa valeur s'affiche ; une extinction
    // est annulée. Le niveau reste lisible poêle éteint, ce qui est justement
    // le moment où on veut le connaître.
    gauge.getCharacteristic(C.Active)
        .onGet(() => C.Active.ACTIVE)
        .onSet(() => {
          setTimeout(() => gauge.updateCharacteristic(C.Active, C.Active.ACTIVE), GAUGE_REVERT_DELAY)
        })

    // La permission d'écriture est conservée volontairement : Apple Home
    // n'affiche pas une caractéristique en lecture seule. Une écriture est
    // donc acceptée puis annulée — le curseur revient au niveau réel.
    const level = gauge.getCharacteristic(C.RotationSpeed)
    level.setProps({ minValue: 0, maxValue: 100, minStep: 1 })
    level.updateValue(this.pelletLevelPercent)
    level.onGet(() => this.pelletLevelPercent)
        .onSet(() => {
          this.log.debug('Curseur de niveau déplacé — retour à la valeur réelle')
          setTimeout(() => level.updateValue(this.pelletLevelPercent), GAUGE_REVERT_DELAY)
        })
    this.services.gauge = gauge

    // Durée avant entretien, sur le même principe : un second bloc dans la
    // fiche, exprimé en pourcentage de l'intervalle de nettoyage restant.
    if (this.serviceGauge) {
      const svcGauge = this.serviceOn(heater.accessory, this.Service.Fanv2,
        `${this.name} entretien`, 'servicegauge')
      this.nameService(svcGauge, this.config.serviceGaugeName || 'Entretien')
      svcGauge.getCharacteristic(C.Active)
          .onGet(() => C.Active.ACTIVE)
          .onSet(() => {
            setTimeout(() => svcGauge.updateCharacteristic(C.Active, C.Active.ACTIVE), GAUGE_REVERT_DELAY)
          })
      const svcLevel = svcGauge.getCharacteristic(C.RotationSpeed)
      svcLevel.setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      svcLevel.updateValue(this.serviceLifePercent)
      svcLevel.onGet(() => this.serviceLifePercent)
          .onSet(() => {
            setTimeout(() => svcLevel.updateValue(this.serviceLifePercent), GAUGE_REVERT_DELAY)
          })
      this.services.serviceGauge = svcGauge
    } else {
      const stale = heater.accessory.getServiceById(this.Service.Fanv2, 'servicegauge')
      if (stale) heater.accessory.removeService(stale)
      this.services.serviceGauge = null
    }

    // Température de flamme dans la fiche du poêle, ajoutée après les deux
    // ventilateurs pour apparaître en dessous d'eux.
    if (this.flameInCard) {
      const flameSvc = this.serviceOn(heater.accessory, this.Service.TemperatureSensor,
        `${this.name} flamme`, 'flame')
      this.nameService(flameSvc, this.config.flameServiceName || 'Flamme')
      // La flamme dépasse largement les 100 °C par défaut du type.
      flameSvc.getCharacteristic(C.CurrentTemperature)
          .setProps({ minValue: -50, maxValue: 1000, minStep: 1 })
          .onGet(() => this.FlameTemperature)
      this.services.flameInCard = flameSvc
    } else {
      const stale = heater.accessory.getServiceById(this.Service.TemperatureSensor, 'flame')
      if (stale) heater.accessory.removeService(stale)
      this.services.flameInCard = null
    }

    // Le service Battery double l'information et porte l'alerte de niveau bas.
    const heaterBattery = this.serviceOn(heater.accessory, this.Service.Battery, `${this.name} pellets`)
    heaterBattery.getCharacteristic(C.BatteryLevel).onGet(() => this.pelletLevelPercent)
    heaterBattery.getCharacteristic(C.StatusLowBattery)
        .onGet(() => this.pelletLevelPercent <= this.lowPelletPercent ? 1 : 0)
    heaterBattery.setCharacteristic(C.ChargingState, C.ChargingState.NOT_CHARGEABLE)

    this.services.heater = h
    this.services.heaterBattery = heaterBattery
    ;(heater.isNew ? created : []).push(heater.accessory)

    // --- 2. Niveau de pellets ---------------------------------------------
    // Apple Home n'affiche aucune tuile pour un service Battery seul. Un
    // capteur d'humidité est le seul type qui présente un pourcentage dans
    // une tuile : le libellé est trompeur, la lisibilité y gagne. Le service
    // Battery est conservé à côté pour l'alerte de niveau bas.
    // Tuile autonome facultative. Le niveau y passe par un capteur
    // d'humidité, seul type qu'Apple Home affiche en pourcentage : le libellé
    // est trompeur, d'où le choix de ne pas l'activer par défaut.
    const pellets = this.buildAccessory('pellets', `${this.name} pellets`, Cat.SENSOR,
      this.config.pelletSensorAccessory === true)
    if (pellets.unwanted) {
      if (pellets.accessory) removed.push(pellets.accessory)
      this.services.pelletLevel = null
      this.services.pelletBattery = null
    } else {
      this.describe(pellets.accessory, 'Niveau de pellets', 'pellets')
      const level = this.serviceOn(pellets.accessory, this.Service.HumiditySensor, `${this.name} pellets`)
      level.getCharacteristic(C.CurrentRelativeHumidity)
          .onGet(() => this.pelletLevelPercent)
      level.getCharacteristic(C.StatusLowBattery)
          .onGet(() => this.pelletLevelPercent <= this.lowPelletPercent ? 1 : 0)
      const battery = this.serviceOn(pellets.accessory, this.Service.Battery, `${this.name} pellets`)
      battery.getCharacteristic(C.BatteryLevel).onGet(() => this.pelletLevelPercent)
      battery.getCharacteristic(C.StatusLowBattery)
          .onGet(() => this.pelletLevelPercent <= this.lowPelletPercent ? 1 : 0)
      battery.setCharacteristic(C.ChargingState, C.ChargingState.NOT_CHARGEABLE)
      this.services.pelletLevel = level
      this.services.pelletBattery = battery
      ;(pellets.isNew ? created : []).push(pellets.accessory)
    }

    // --- 3. Interrupteur de plein ------------------------------------------
    const refill = this.buildAccessory('refill', `${this.name} plein`, Cat.SWITCH,
      this.config.refillSwitch !== false)
    if (refill.unwanted) {
      if (refill.accessory) removed.push(refill.accessory)
    } else {
      this.describe(refill.accessory, 'Plein de pellets', 'refill')
      const sw = this.serviceOn(refill.accessory, this.Service.Switch, `${this.name} plein`)
      sw.getCharacteristic(C.On)
          .onGet(() => false)
          .onSet((value) => {
            if (value) {
              this.manualRefill().catch((error) => this.log('Erreur lors du plein:', error.message))
              // Interrupteur sans état : il retombe de lui-même.
              setTimeout(() => sw.updateCharacteristic
                ? sw.updateCharacteristic(C.On, false)
                : sw.getCharacteristic(C.On).updateValue(false), REFILL_SWITCH_RESET_DELAY)
            }
          })
      this.services.refill = sw
      ;(refill.isNew ? created : []).push(refill.accessory)
    }

    // --- 4. Entretien ------------------------------------------------------
    const service = this.buildAccessory('service', `${this.name} entretien`, Cat.SENSOR,
      this.healthSensors)
    if (service.unwanted) {
      if (service.accessory) removed.push(service.accessory)
    } else {
      this.describe(service.accessory, 'Entretien', 'service')
      // Un contact est le type le plus exploitable en automatisation :
      // ouvert = entretien à faire.
      const due = this.serviceOn(service.accessory, this.Service.ContactSensor, `${this.name} entretien`)
      due.getCharacteristic(C.ContactSensorState)
          .onGet(() => this.serviceDue
            ? C.ContactSensorState.CONTACT_NOT_DETECTED
            : C.ContactSensorState.CONTACT_DETECTED)
      const filter = this.serviceOn(service.accessory, this.Service.FilterMaintenance, `${this.name} entretien`)
      filter.getCharacteristic(C.FilterChangeIndication)
          .onGet(() => this.serviceDue
            ? C.FilterChangeIndication.CHANGE_FILTER
            : C.FilterChangeIndication.FILTER_OK)
      filter.getCharacteristic(C.FilterLifeLevel).onGet(() => this.serviceLifePercent)
      this.services.serviceDue = due
      this.services.serviceFilter = filter
      ;(service.isNew ? created : []).push(service.accessory)
    }

    // --- 5. Température de flamme ------------------------------------------
    // Un accessoire distinct : seul un accessoire capteur affiche sa valeur
    // sur une vignette.
    const flame = this.buildAccessory('flame', `${this.name} flamme`, Cat.SENSOR, this.flameSensor)
    if (flame.unwanted) {
      if (flame.accessory) removed.push(flame.accessory)
      this.services.flame = null
    } else {
      this.describe(flame.accessory, 'Température de flamme', 'flame')
      const probe = this.serviceOn(flame.accessory, this.Service.TemperatureSensor, `${this.name} flamme`)
      // La flamme dépasse largement les 100 °C par défaut du type.
      probe.getCharacteristic(C.CurrentTemperature)
          .setProps({ minValue: -50, maxValue: 1000, minStep: 1 })
          .onGet(() => this.FlameTemperature)
      this.services.flame = probe
      ;(flame.isNew ? created : []).push(flame.accessory)
    }

    // --- 6. Défaut ---------------------------------------------------------
    const fault = this.buildAccessory('fault', `${this.name} défaut`, Cat.SENSOR,
      this.healthSensors)
    if (fault.unwanted) {
      if (fault.accessory) removed.push(fault.accessory)
    } else {
      this.describe(fault.accessory, 'Défaut', 'fault')
      const contact = this.serviceOn(fault.accessory, this.Service.ContactSensor, `${this.name} défaut`)
      contact.getCharacteristic(C.ContactSensorState)
          .onGet(() => this.faultActive
            ? C.ContactSensorState.CONTACT_NOT_DETECTED
            : C.ContactSensorState.CONTACT_DETECTED)
      this.services.fault = contact
      ;(fault.isNew ? created : []).push(fault.accessory)
    }

    if (created.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, created)
      this.log(`${created.length} accessoire(s) ajouté(s) : ${created.map((a) => a.displayName).join(', ')}`)
    }
    if (removed.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removed)
      this.log(`${removed.length} accessoire(s) retiré(s) : ${removed.map((a) => a.displayName).join(', ')}`)
    }
  }

  // -------------------------------------------------------------------------
  // Lecture et commandes
  // -------------------------------------------------------------------------

  async readCharacteristic (characteristic) {
    const cacheAge = Date.now() - this.latestUpdateTimestamp
    if (cacheAge > 5000) {
      // On répond toujours, même en cas d'échec : servir la dernière valeur
      // connue vaut mieux que laisser HomeKit afficher « Pas de réponse ».
      await this.updateStatus().catch(() => {})
    }
    return this[characteristic]
  }

  startPeriodicUpdates () {
    if (this.updateTimer) {
      clearInterval(this.updateTimer)
    }
    this.updateTimer = setInterval(() => {
      this.log.debug('Mise à jour périodique...')
      this.updateStatus()
    }, this.updateInterval)
  }

  async setActive (value) {
    this.log(`Changement de mode: ${value ? 'ON' : 'OFF'}`)
    this.Active = value ? 1 : 0
    await this.updateCharacteristic('onOff', value === 1 || value === true)
  }

  async setTargetTemperature (value) {
    this.log(`Température cible mode confort: ${value}°C`)
    this.TargetTemperature = value
    await this.updateCharacteristic('targetTemperature', value)
  }

  // Une seule requête en vol : les appelants simultanés la partagent.
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
      result = await this.client.getStatus()
    } catch (error) {
      this.log('Erreur lors de la récupération du statut:', error.message)
      return
    }

    const { status, body } = result

    if (status === 401) {
      this.log('Session expirée, reconnexion...')
      this.client.login(() => this.updateStatus())
      return
    }
    if (status === 500) {
      this.log('Erreur serveur Firenet - Le poêle est-il lié à ce compte?')
      return
    }
    if (status !== 200 || !body || body.stoveID !== this.config.stoveID) {
      this.log(`Erreur inattendue: ${status}`)
      return
    }

    try {
      this.currentControls = body.controls
      this.TargetTemperature = body.controls.targetTemperature
      this.CurrentTemperature = body.sensors.inputRoomTemperature
      this.revision = body.controls.revision

      const mainState = body.sensors.statusMainState
      const subState = body.sensors.statusSubState
      const isOn = body.controls.onOff === true

      this.log.debug(`États: mainState=${mainState}, subState=${subState}, onOff=${isOn}`)

      this.Active = isOn ? 1 : 0
      if (!isOn) {
        this.CurrentHeaterCoolerState = 0 // INACTIVE
      } else if (mainState >= 2 && mainState <= 5) {
        this.CurrentHeaterCoolerState = 2 // HEATING, combustion en cours
      } else {
        this.CurrentHeaterCoolerState = 1 // IDLE, sous tension sans flamme
      }
      const flameTemp = Number(body.sensors.inputFlameTemperature)
      if (Number.isFinite(flameTemp)) {
        this.FlameTemperature = flameTemp
      }

      // Puissance de chauffe : relevée pour le journal. Elle n'occupe plus le
      // curseur, désormais dédié au niveau de pellets.
      const power = Number(body.controls.heatingPower)
      if (Number.isFinite(power)) {
        this.HeatingPower = power
        this.log.debug(`Puissance de chauffe du poêle: ${power} %`)
      }

      this.latestUpdateTimestamp = Date.now()
      this.log.debug(`✓ Statut mis à jour - Temp: ${this.CurrentTemperature}°C / Cible: ${this.TargetTemperature}°C / État: ${isOn ? 'ON' : 'OFF'}`)

      this.updatePelletLevel(body.sensors)
      this.updateHealth(body.sensors)
      this.publishHeater()
    } catch (parseError) {
      this.log('Erreur lors du traitement des données:', parseError.message)
    }
  }

  publishHeater () {
    const C = this.Characteristic
    const h = this.services.heater
    if (!h) return
    h.getCharacteristic(C.Active).updateValue(this.Active)
    h.getCharacteristic(C.CurrentHeaterCoolerState).updateValue(this.CurrentHeaterCoolerState)
    h.getCharacteristic(C.CurrentTemperature).updateValue(this.CurrentTemperature)
    h.getCharacteristic(C.HeatingThresholdTemperature).updateValue(this.TargetTemperature)
    for (const svc of [this.services.flame, this.services.flameInCard]) {
      if (svc) svc.getCharacteristic(C.CurrentTemperature).updateValue(this.FlameTemperature)
    }
  }

  async updateCharacteristic (controlItem, value) {
    this.log(`Envoi de la mise à jour: ${controlItem} = ${value}`)

    const { status, body } = await this.client.getStatus()

    if (status === 401) {
      this.log('Session expirée, reconnexion...')
      this.client.login(() => this.updateCharacteristic(controlItem, value))
      return
    }
    if (status !== 200 || !body || body.stoveID !== this.config.stoveID) {
      this.log(`Erreur inattendue: ${status}`)
      throw new Error(`Unexpected response ${status}`)
    }

    const controls = body.controls
    controls[controlItem] = value

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
    const response = await this.client.sendControls(formData)

    if (response.status === 200) {
      this.log(`✓ ${controlItem} défini sur: ${value}`)
      setTimeout(() => this.updateStatus(), CONFIRM_DELAY)
      return
    }

    const text = await response.text().catch(() => '')
    this.log(`✗ Échec de la mise à jour de ${controlItem}: ${response.status} - ${text}`)
    throw new Error(`Failed to update ${controlItem}`)
  }

  // -------------------------------------------------------------------------
  // Santé du poêle
  // -------------------------------------------------------------------------

  updateHealth (sensors) {
    const countdown = Number(sensors.parameterServiceCountdownKg)
    const interval = Number(sensors.parameterKgTillCleaning)
    if (Number.isFinite(countdown) && Number.isFinite(interval) && interval > 0) {
      const wasDue = this.serviceDue
      this.serviceCountdownKg = countdown
      this.serviceLifePercent = Math.max(0, Math.min(100, Math.round((countdown / interval) * 100)))
      this.serviceDue = countdown <= this.serviceAlertKg

      if (this.serviceDue && !wasDue) {
        this.log(`⚠ Entretien à prévoir : encore ${countdown} kg de pellets avant le grand nettoyage (intervalle ${interval} kg)`)
      } else if (!this.serviceDue && wasDue) {
        this.log(`✓ Entretien effectué — compteur réarmé à ${countdown} kg`)
      } else {
        this.log.debug(`Entretien: ${countdown} kg restants sur ${interval} (${this.serviceLifePercent} %)`)
      }
    }

    const error = Number(sensors.statusError) || 0
    const subError = Number(sensors.statusSubError) || 0
    const warning = Number(sensors.statusWarning) || 0
    const wasFault = this.faultActive
    this.faultActive = error !== 0 || subError !== 0 || warning !== 0
    this.faultDetail = `statusError=${error} statusSubError=${subError} statusWarning=${warning}`

    if (this.faultActive && !wasFault) {
      this.log(`⚠ Défaut signalé par le poêle — ${this.faultDetail}`)
    } else if (!this.faultActive && wasFault) {
      this.log('✓ Défaut résolu — le poêle ne signale plus rien')
    }

    this.publishHealth()
  }

  publishHealth () {
    const C = this.Characteristic
    if (this.services.serviceFilter) {
      this.services.serviceFilter.getCharacteristic(C.FilterChangeIndication)
          .updateValue(this.serviceDue ? C.FilterChangeIndication.CHANGE_FILTER : C.FilterChangeIndication.FILTER_OK)
      this.services.serviceFilter.getCharacteristic(C.FilterLifeLevel)
          .updateValue(this.serviceLifePercent)
    }
    if (this.services.serviceGauge) {
      this.services.serviceGauge.getCharacteristic(C.RotationSpeed)
          .updateValue(this.serviceLifePercent)
    }
    if (this.services.serviceDue) {
      this.services.serviceDue.getCharacteristic(C.ContactSensorState)
          .updateValue(this.serviceDue ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED)
    }
    if (this.services.fault) {
      this.services.fault.getCharacteristic(C.ContactSensorState)
          .updateValue(this.faultActive ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED)
    }
  }

  // -------------------------------------------------------------------------
  // Niveau de pellets
  // -------------------------------------------------------------------------

  get pelletStatePath () {
    const dir = (this.api && this.api.user && typeof this.api.user.storagePath === 'function')
      ? this.api.user.storagePath()
      : '/var/lib/homebridge'
    return `${dir}/rika-pellets-${this.config.stoveID}.json`
  }

  loadPelletState () {
    try {
      const saved = JSON.parse(fs.readFileSync(this.pelletStatePath, 'utf8'))
      if (Number.isFinite(saved.feedRateTotalAtRefill)) {
        this.pelletState = {
          feedRateTotalAtRefill: saved.feedRateTotalAtRefill,
          lastRefillAt: saved.lastRefillAt || null
        }
        this.log.debug(`État pellets rechargé: plein à ${saved.feedRateTotalAtRefill} kg (${saved.lastRefillAt})`)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log("Impossible de relire l'état des pellets:", error.message)
      }
    }
  }

  savePelletState () {
    try {
      fs.writeFileSync(this.pelletStatePath, JSON.stringify({
        stoveID: this.config.stoveID,
        hopperCapacityKg: this.hopperCapacityKg,
        feedRateTotalAtRefill: this.pelletState.feedRateTotalAtRefill,
        lastRefillAt: this.pelletState.lastRefillAt
      }, null, 2), { mode: 0o600 })
    } catch (error) {
      this.log("Impossible d'enregistrer l'état des pellets:", error.message)
    }
  }

  registerRefill (feedRateTotal) {
    this.pelletState = {
      feedRateTotalAtRefill: feedRateTotal,
      lastRefillAt: new Date().toISOString()
    }
    this.savePelletState()
    this.pelletsRemainingKg = this.hopperCapacityKg
    this.pelletLevelPercent = 100
    this.publishPelletLevel()
  }

  async manualRefill () {
    if (this.lastFeedRateTotal === null) {
      await this.updateStatus()
    }
    if (this.lastFeedRateTotal === null) {
      this.log('✗ Plein non enregistré : compteur de pellets indisponible')
      return
    }
    this.log(`✓ Plein enregistré manuellement (compteur à ${this.lastFeedRateTotal} kg) — réservoir à ${this.hopperCapacityKg} kg`)
    this.registerRefill(this.lastFeedRateTotal)
  }

  updatePelletLevel (sensors) {
    const total = Number(sensors.parameterFeedRateTotal)
    if (!Number.isFinite(total)) {
      return
    }
    this.lastFeedRateTotal = total

    // Le poêle signale le couvercle ouvert par un code d'avertissement ; sa
    // disparition signe la fermeture, donc la fin du plein. Aucun contact de
    // la charge utile FireNet ne bouge à l'ouverture.
    const warning = Number(sensors.statusWarning) || 0
    const wasOpen = this.previousWarning === this.refillWarningCode
    this.previousWarning = warning

    if (this.autoDetectRefill && wasOpen && warning === 0) {
      this.log(`✓ Couvercle du réservoir refermé (avertissement ${this.refillWarningCode} levé) — plein enregistré, compteur à ${total} kg`)
      this.registerRefill(total)
      return
    }

    if (this.pelletState.feedRateTotalAtRefill === null) {
      this.log(`Premier relevé du compteur de pellets (${total} kg) — réservoir supposé plein (${this.hopperCapacityKg} kg)`)
      this.registerRefill(total)
      return
    }

    let consumed = total - this.pelletState.feedRateTotalAtRefill
    if (consumed < 0) {
      this.log(`Compteur de pellets reparti en arrière (${total} kg < ${this.pelletState.feedRateTotalAtRefill} kg) — réancrage`)
      this.registerRefill(total)
      return
    }

    const remaining = Math.max(0, this.hopperCapacityKg - consumed)
    const percent = Math.max(0, Math.min(100, Math.round((remaining / this.hopperCapacityKg) * 100)))
    const wasLow = this.pelletLevelPercent <= this.lowPelletPercent

    this.pelletsRemainingKg = remaining
    this.pelletLevelPercent = percent
    this.publishPelletLevel()

    if (percent <= this.lowPelletPercent && !wasLow) {
      this.log(`⚠ Niveau de pellets bas : ${percent} % — environ ${remaining} kg restants sur ${this.hopperCapacityKg} kg`)
    } else {
      this.log.debug(`Pellets: ${percent} % — ~${remaining} kg restants, ${consumed} kg consommés depuis le plein`)
    }
  }

  publishPelletLevel () {
    const C = this.Characteristic
    const low = this.pelletLevelPercent <= this.lowPelletPercent ? 1 : 0
    if (this.services.gauge) {
      this.services.gauge.getCharacteristic(C.RotationSpeed)
          .updateValue(this.pelletLevelPercent)
    }
    if (this.services.pelletLevel) {
      this.services.pelletLevel.getCharacteristic(C.CurrentRelativeHumidity)
          .updateValue(this.pelletLevelPercent)
      this.services.pelletLevel.getCharacteristic(C.StatusLowBattery).updateValue(low)
    }
    if (this.services.heaterBattery) {
      this.services.heaterBattery.getCharacteristic(C.BatteryLevel)
          .updateValue(this.pelletLevelPercent)
      this.services.heaterBattery.getCharacteristic(C.StatusLowBattery).updateValue(low)
    }
    if (this.services.pelletBattery) {
      this.services.pelletBattery.getCharacteristic(C.BatteryLevel)
          .updateValue(this.pelletLevelPercent)
      this.services.pelletBattery.getCharacteristic(C.StatusLowBattery).updateValue(low)
    }
  }
}

module.exports.RIKAFirenetPlatform = RIKAFirenetPlatform
module.exports.FirenetClient = FirenetClient
