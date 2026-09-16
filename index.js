'use strict'

let Service, Characteristic
const request = require('request').defaults({jar: true}) // Save cookies to maintain logged in state

module.exports = (homebridge) => {
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  homebridge.registerAccessory('homebridge-rika-firenet', 'RIKAFirenet', RIKAFirenetAccessory)
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

    this.callbackQueue = []
    this.latestUpdateTimestamp = 0
    this.connected = false
    this.currentlyUpdating = false
    
    // Stockage des contrôles complets pour les mises à jour
    this.currentControls = null
    
    // Configuration de l'intervalle de mise à jour automatique (toutes les 60 secondes)
    this.updateInterval = this.config.updateInterval || 60000
    
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
        .on('get', this.getCharacteristic.bind(this, "CurrentHeatingCoolingState"))
        .setProps({
          maxValue: 2,
          minValue: 0,
          validValues: [0, 1, 2] // OFF, HEAT, COOL
        })

    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .on('get', this.getCharacteristic.bind(this, "TargetHeatingCoolingState"))
        .on('set', this.setTargetHeatingCoolingState.bind(this))
        .setProps({
          maxValue: 1,
          minValue: 0,
          validValues: [0, 1] // OFF, HEAT seulement (pas de COOL ni AUTO)
        })

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
        .on('get', this.getCharacteristic.bind(this, "CurrentTemperature"))
        .setProps({
          minValue: -50,
          maxValue: 100,
          minStep: 0.1
        })

    this.service.getCharacteristic(Characteristic.TargetTemperature)
        .on('get', this.getCharacteristic.bind(this, "TargetTemperature"))
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

  startPeriodicUpdates() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer)
    }
    
    this.updateTimer = setInterval(() => {
      this.log("Mise à jour périodique...")
      this.updateStatus()
    }, this.updateInterval)
  }

  setTargetHeatingCoolingState(value, callback) {
    this.log(`Changement de mode: ${value === 0 ? 'OFF' : value === 1 ? 'HEAT' : 'AUTO'}`)
    this.TargetHeatingCoolingState = value
    
    // Si on met sur OFF, éteindre le poêle
    if (value === 0) {
      this.updateCharacteristic("onOff", false, callback)
    } else {
      // Si on met sur HEAT ou AUTO, allumer le poêle
      this.updateCharacteristic("onOff", true, callback)
    }
  }

  setTargetTemperature(value, callback) {
    this.log(`Température cible mode confort: ${value}°C`)
    this.TargetTemperature = value
    this.updateCharacteristic("targetTemperature", value, callback)
  }

  loginToFirenet (onSuccess) {
    this.log("Connexion à Firenet...")
    const loginData = {
      email: this.config.FirenetEmail,
      password: this.config.FirenetPassword
    }

    request.post({
      url: 'https://www.rika-firenet.com/web/login',
      form: loginData,
      timeout: 10000
    }, (error, response, body) => {
      if (error) {
        this.log("Erreur de connexion:", error.message)
        this.connected = false
        // Réessayer après 30 secondes
        setTimeout(() => this.loginToFirenet(onSuccess), 30000)
        return
      }

      if (body && body.indexOf("summary") > -1) {
        this.log("✓ Connecté à Firenet")
        this.connected = true
        if (typeof onSuccess === "function") {
          onSuccess()
        }
      } else {
        this.log("✗ Échec de connexion à Firenet - Vérifiez vos identifiants")
        this.connected = false
      }
    })
  }

  updateStatus () {
    if (this.currentlyUpdating) {
      this.log("Mise à jour déjà en cours, abandon...")
      return
    }

    this.currentlyUpdating = true
    this.log("Mise à jour du statut...")

    request.get({
      url: `https://www.rika-firenet.com/api/client/${this.config.stoveID}/status`,
      timeout: 10000,
      json: true
    }, (error, response, body) => {
      this.currentlyUpdating = false

      if (error) {
        this.log("Erreur lors de la récupération du statut:", error.message)
        return
      }

      if (response.statusCode === 200 && body && body.stoveID === this.config.stoveID) {
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
          
          // Logs de debug
          this.log(`États: mainState=${mainState}, subState=${subState}, onOff=${isOn}`)
          
          // Définir CurrentHeatingCoolingState (ce que fait le poêle actuellement)
          if (!isOn || (mainState === 0 && subState === 1)) {
            this.CurrentHeatingCoolingState = 0 // OFF
          } else if (mainState >= 2 && mainState <= 5) {
            this.CurrentHeatingCoolingState = 1 // HEATING
          } else {
            this.CurrentHeatingCoolingState = 1 // IDLE mais allumé = HEATING
          }
          
          // Définir TargetHeatingCoolingState (ce que veut l'utilisateur)
          if (!isOn) {
            this.TargetHeatingCoolingState = 0 // OFF
          } else {
            this.TargetHeatingCoolingState = 1 // HEAT
          }

          this.latestUpdateTimestamp = Date.now()
          this.log(`✓ Statut mis à jour - Temp: ${this.CurrentTemperature}°C / Cible: ${this.TargetTemperature}°C / État: ${this.CurrentHeatingCoolingState === 0 ? 'OFF' : 'HEATING'}`)

          // Mise à jour des valeurs dans HomeKit
          this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(this.CurrentHeatingCoolingState)
          this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(this.TargetHeatingCoolingState)
          this.service.getCharacteristic(Characteristic.CurrentTemperature).updateValue(this.CurrentTemperature)
          this.service.getCharacteristic(Characteristic.TargetTemperature).updateValue(this.TargetTemperature)

          // Traitement de la file d'attente des callbacks
          while (this.callbackQueue.length > 0) {
            const item = this.callbackQueue.shift()
            this.getCharacteristic(item.characteristic, item.callback)
          }

        } catch (parseError) {
          this.log("Erreur lors du traitement des données:", parseError.message)
        }

      } else if (response.statusCode === 401) {
        this.log("Session expirée, reconnexion...")
        this.loginToFirenet(() => this.updateStatus())
      } else if (response.statusCode === 500) {
        this.log("Erreur serveur Firenet - Le poêle est-il lié à ce compte?")
      } else {
        this.log(`Erreur inattendue: ${response.statusCode}`)
      }
    })
  }

  getCharacteristic(characteristic, callback) {
    const cacheAge = Date.now() - this.latestUpdateTimestamp
    
    if (cacheAge > 5000) { // Cache de 5 secondes
      this.log(`→ Récupération depuis le serveur: ${characteristic}`)
      this.callbackQueue.push({callback: callback, characteristic: characteristic})
      this.updateStatus()
    } else {
      this.log(`→ Récupération depuis le cache: ${characteristic} = ${this[characteristic]}`)
      callback(null, this[characteristic])
    }
  }

  updateCharacteristic(controlItem, value, callback) {
    this.log(`Envoi de la mise à jour: ${controlItem} = ${value}`)
    
    // D'abord récupérer le statut actuel pour avoir tous les paramètres
    request.get({
      url: `https://www.rika-firenet.com/api/client/${this.config.stoveID}/status`,
      timeout: 10000,
      json: true
    }, (error, response, body) => {
      if (error) {
        this.log("Erreur lors de la récupération du statut:", error.message)
        callback(error)
        return
      }

      if (response.statusCode === 200 && body && body.stoveID === this.config.stoveID) {
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

          this.log(`Données envoyées: ${JSON.stringify(formData)}`)

          request.post({
            url: `https://www.rika-firenet.com/api/client/${this.config.stoveID}/controls`,
            form: formData,
            timeout: 10000,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest'
            }
          }, (error, response, body) => {
            if (error) {
              this.log("Erreur lors de l'envoi de la commande:", error.message)
              callback(error)
              return
            }

            if (response.statusCode === 200) {
              this.log(`✓ ${controlItem} défini sur: ${value}`)
              // Forcer une mise à jour après 2 secondes pour vérifier le changement
              setTimeout(() => this.updateStatus(), 2000)
              callback(null)
            } else {
              this.log(`✗ Échec de la mise à jour de ${controlItem}: ${response.statusCode} - ${body}`)
              callback(new Error(`Failed to update ${controlItem}`))
            }
          })
        } catch (parseError) {
          this.log("Erreur lors du traitement des données:", parseError.message)
          callback(parseError)
        }

      } else if (response.statusCode === 401) {
        this.log("Session expirée, reconnexion...")
        this.loginToFirenet(() => this.updateCharacteristic(controlItem, value, callback))
      } else if (response.statusCode === 500) {
        this.log("Erreur serveur Firenet")
        callback(new Error("Firenet server error"))
      }
    })
  }
}

module.exports.RIKAFirenetAccessory = RIKAFirenetAccessory