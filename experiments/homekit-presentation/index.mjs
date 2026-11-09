// Isolated synthetic fixture. No imports from the production plugin or network libraries.
export const PLUGIN_NAME = 'homebridge-toniebox-presentation-fixture';
export const PLATFORM_NAME = 'TonieboxPresentationFixture';
const instances = new WeakSet();
const scenarios = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const externalScenarios = ['A', 'D', 'E', 'F', 'G', 'H', 'I'];
const playbackStates = ['playing', 'paused', 'no-media'];
const batteryStates = ['charging', 'discharging', 'low', 'unknown'];

export function readConfiguration(config) {
  try {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return undefined;
    }
    const { fixtureOnly, scenario, playback, battery, unavailable } = config;
    if (fixtureOnly !== true || !scenarios.includes(scenario) || !playbackStates.includes(playback)
      || !batteryStates.includes(battery) || typeof unavailable !== 'boolean') {
      return undefined;
    }
    const allowed = ['platform', 'name', 'fixtureOnly', 'scenario', 'playback', 'battery', 'unavailable'];
    if (Object.keys(config).some(key => !allowed.includes(key))) {
      return undefined;
    }
    return Object.freeze({ scenario, playback, battery, unavailable });
  } catch {
    return undefined;
  }
}

export function fixtureUuid(api, scenario) {
  if (!scenarios.includes(scenario)) {
    throw new Error('Invalid synthetic scenario');
  }
  return api.hap.uuid.generate('homebridge-toniebox:synthetic-presentation:v1:' + scenario);
}

export class PresentationPlatform {
  #api;
  #log;
  #config;
  #accessory;
  #started = false;
  #stopped = false;
  #launch;
  #shutdown;

  constructor(log, config, api) {
    this.#api = api;
    this.#log = log;
    this.#config = readConfiguration(config);
    try {
      const storage = api.user.storagePath().replaceAll('\\', '/').replace(/\/$/, '');
      if (!this.#config || !storage.endsWith('/toniebox-presentation-' + this.#config.scenario) || instances.has(api)) {
        this.#stopped = true;
        this.#notice('Synthetic fixture inactive: invalid configuration, storage or duplicate platform.');
        return;
      }
      instances.add(api);
      this.#launch = () => this.start();
      this.#shutdown = () => this.stop();
      api.on('didFinishLaunching', this.#launch);
      api.on('shutdown', this.#shutdown);
    } catch {
      this.stop();
      this.#notice('Synthetic fixture inactive: setup failed.');
    }
  }

  #notice(message) {
    try {
      // Only fixed fixture-owned text reaches the logger.
      void Promise.resolve(this.#log.info(message)).catch(() => undefined);
    } catch {
      // Logging cannot affect fixture ownership.
    }
  }

  configureAccessory(accessory) {
    if (this.#stopped) {
      return;
    }
    try {
      if (this.#started || externalScenarios.includes(this.#config.scenario)
        || accessory.UUID !== fixtureUuid(this.#api, this.#config.scenario)
        || accessory.context?.fixture !== '8a1' || accessory.context?.scenario !== this.#config.scenario
        || (this.#accessory && this.#accessory !== accessory)) {
        throw new Error('Unexpected synthetic cache');
      }
      this.#accessory = accessory;
      this.#configure(accessory);
    } catch {
      this.stop();
      this.#notice('Synthetic fixture stopped: unexpected cache. Use the dedicated scenario storage.');
    }
  }

  #media;
  #volume = 50;
  #mute = false;
  #changing = false;
  #writeLogCount = 0;

  #writeNotice(message) {
    if (!this.#stopped && this.#writeLogCount < 32) {
      this.#writeLogCount++;
      this.#notice(message);
    }
  }

  #simulate(value, viaSwitch, speaker, playbackSwitch, acknowledge) {
    const { Characteristic: C, HapStatusError, HAPStatus: H } = this.#api.hap;
    this.#read(true);
    if (this.#changing) {
      throw new HapStatusError(H.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    // Own the whole operation, including logger callbacks, before permitting reentrancy.
    this.#changing = true;
    try {
      this.#writeNotice(viaSwitch ? 'Synthetic switch write received.' : 'Synthetic media write received.');
      this.#read(true); // Reentrant logger shutdown also revokes this write.
      if ((viaSwitch && typeof value !== 'boolean')
        || (!viaSwitch && (!Number.isInteger(value)
          || ![C.TargetMediaState.PLAY, C.TargetMediaState.PAUSE, C.TargetMediaState.STOP].includes(value)))) {
        this.#writeNotice('Synthetic write rejected: invalid value.');
        throw new HapStatusError(H.INVALID_VALUE_IN_REQUEST);
      }
      if (this.#media === C.CurrentMediaState.STOP || (!viaSwitch && value === C.TargetMediaState.STOP)) {
        this.#writeNotice('Synthetic write rejected: transition not allowed.');
        throw new HapStatusError(H.NOT_ALLOWED_IN_CURRENT_STATE);
      }
      const next = viaSwitch ? value ? C.CurrentMediaState.PLAY : C.CurrentMediaState.PAUSE : value;
      try {
        // Commit the synthetic model before synchronous HAP observers can read it.
        this.#media = next;
        if (speaker) {
          speaker.getCharacteristic(C.CurrentMediaState).updateValue(next);
          this.#read(true);
          speaker.getCharacteristic(C.TargetMediaState).updateValue(next);
          this.#read(true);
        }
        if (playbackSwitch) {
          playbackSwitch.getCharacteristic(C.On).updateValue(next === C.CurrentMediaState.PLAY);
          this.#read(true);
        }
        this.#writeNotice(next === C.CurrentMediaState.PLAY ? 'Synthetic transition applied: playing.' : 'Synthetic transition applied: paused.');
        this.#read(true);
        acknowledge?.();
      } catch {
        // An interrupted/failed update must not be acknowledged as a successful write.
        this.stop();
        throw new HapStatusError(H.SERVICE_COMMUNICATION_FAILURE);
      }
    } finally {
      this.#changing = false;
    }
  }


  #controls(accessory, speaker) {
    const { Service, Characteristic: C } = this.#api.hap;
    speaker.getCharacteristic(C.CurrentMediaState).onGet(() => this.#read(this.#media));
    speaker.getCharacteristic(C.TargetMediaState).onGet(() => this.#read(this.#media));
    let playbackSwitch;
    if (this.#config.scenario !== 'E') {
      playbackSwitch = accessory.addService(Service.Switch, 'Playback', 'synthetic-playback');
      const on = this.#media === C.CurrentMediaState.STOP ? undefined : this.#media === C.CurrentMediaState.PLAY;
      this.#characteristic(playbackSwitch, C.On, on);
      playbackSwitch.getCharacteristic(C.On)
        .onGet(() => this.#read(this.#media === C.CurrentMediaState.STOP ? undefined : this.#media === C.CurrentMediaState.PLAY));
      this.#writeHandler(playbackSwitch.getCharacteristic(C.On),
        (value, acknowledge) => this.#simulate(value, true, speaker, playbackSwitch, acknowledge));
    }
    if (this.#config.scenario !== 'F') {
      this.#writeHandler(speaker.getCharacteristic(C.TargetMediaState),
        (value, acknowledge) => this.#simulate(value, false, speaker, playbackSwitch, acknowledge));
    }
    // F keeps its rejecting target handler; G/H share one model through both inputs.
  }

  #writeHandler(characteristic, operation) {
    if (!['G', 'H', 'I'].includes(this.#config.scenario)) {
      characteristic.onSet(value => operation(value));
      return;
    }
    // The supported synchronous callback API completes HAP's cache update under our
    // guard. onSet awaits the handler and could otherwise replay an older write
    // over a concurrent transition from the other control.
    characteristic.removeOnSet();
    characteristic.on('set', (value, done) => {
      let acknowledged = false;
      try {
        operation(value, () => {
          acknowledged = true;
          done(null);
        });
      } catch (error) {
        if (acknowledged) {
          this.stop();
          return;
        }
        const { HapStatusError, HAPStatus: H } = this.#api.hap;
        done(error instanceof HapStatusError ? error : new HapStatusError(H.SERVICE_COMMUNICATION_FAILURE));
      }
    });
  }

  #regularSpeaker(accessory, battery) {
    const { Service, Characteristic: C, HapStatusError, HAPStatus: H } = this.#api.hap;
    const speaker = accessory.addService(Service.Speaker, 'Synthetic Toniebox I');
    speaker.setPrimaryService(true);
    if (!accessory.services.includes(speaker) || !accessory.services.includes(battery)) {
      throw new Error('Synthetic service membership');
    }
    speaker.addLinkedService(battery);
    // Regular Speaker has no media-state characteristics. Only the switch exposes playback.
    this.#media = { playing: C.CurrentMediaState.PLAY, paused: C.CurrentMediaState.PAUSE, 'no-media': C.CurrentMediaState.STOP }[this.#config.playback];
    const playbackSwitch = accessory.addService(Service.Switch, 'Playback', 'synthetic-playback');
    const on = this.#media === C.CurrentMediaState.STOP ? undefined : this.#media === C.CurrentMediaState.PLAY;
    this.#characteristic(playbackSwitch, C.On, on);
    playbackSwitch.getCharacteristic(C.On)
      .onGet(() => this.#read(this.#media === C.CurrentMediaState.STOP ? undefined : this.#media === C.CurrentMediaState.PLAY));
    this.#writeHandler(playbackSwitch.getCharacteristic(C.On),
      (value, acknowledge) => this.#simulate(value, true, undefined, playbackSwitch, acknowledge));
    this.#characteristic(speaker, C.Volume, this.#volume);
    const volume = speaker.getCharacteristic(C.Volume);
    volume.onGet(() => this.#read(this.#volume));
    this.#writeHandler(volume, (value, acknowledge) => this.#simulateAudio(value, false, volume, acknowledge));
    this.#characteristic(speaker, C.Mute, false);
    this.#writeHandler(speaker.getCharacteristic(C.Mute), () => {
      this.#read(true);
      this.#writeNotice('Synthetic mute write rejected: unsupported operation.');
      this.#read(true);
      throw new HapStatusError(H.NOT_ALLOWED_IN_CURRENT_STATE);
    });
  }

  #audio(speaker) {
    const { Characteristic: C } = this.#api.hap;
    for (const [type, muted] of [[C.Volume, false], [C.Mute, true]]) {
      this.#characteristic(speaker, type, muted ? this.#mute : this.#volume);
      const characteristic = speaker.getCharacteristic(type);
      characteristic.onGet(() => this.#read(muted ? this.#mute : this.#volume));
      this.#writeHandler(characteristic, (value, acknowledge) => this.#simulateAudio(value, muted, characteristic, acknowledge));
    }
  }

  #simulateAudio(value, muted, characteristic, acknowledge) {
    const { HapStatusError, HAPStatus: H } = this.#api.hap;
    this.#read(true);
    if (this.#changing) {
      throw new HapStatusError(H.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    this.#changing = true;
    try {
      this.#writeNotice(muted ? 'Synthetic mute write received.' : 'Synthetic volume write received.');
      this.#read(true);
      if (muted ? typeof value !== 'boolean' : !Number.isInteger(value) || value < 0 || value > 100) {
        this.#writeNotice('Synthetic write rejected: invalid value.');
        throw new HapStatusError(H.INVALID_VALUE_IN_REQUEST);
      }
      try {
        if (muted) {
          this.#mute = value;
        } else {
          this.#volume = value;
        }
        characteristic.updateValue(value);
        this.#read(true);
        this.#writeNotice(muted ? 'Synthetic mute transition applied.' : 'Synthetic volume transition applied.');
        this.#read(true);
        acknowledge?.();
      } catch {
        this.stop();
        throw new HapStatusError(H.SERVICE_COMMUNICATION_FAILURE);
      }
    } finally {
      this.#changing = false;
    }
  }

  #read(value) {
    const { HapStatusError, HAPStatus } = this.#api.hap;
    if (this.#stopped || this.#config.unavailable || value === undefined) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return value;
  }

  #characteristic(service, type, value, rejectWrites = false) {
    const characteristic = service.getCharacteristic(type);
    // Cached handlers belong to the old instance; only replace our own handlers.
    characteristic.onGet(() => this.#read(value));
    if (rejectWrites) {
      characteristic.onSet(() => {
        const { HapStatusError, HAPStatus } = this.#api.hap;
        throw new HapStatusError(this.#stopped ? HAPStatus.SERVICE_COMMUNICATION_FAILURE : HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      });
    }
    const { HapStatusError, HAPStatus } = this.#api.hap;
    characteristic.updateValue(this.#config.unavailable || value === undefined
      ? new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE) : value);
  }

  #configure(accessory) {
    const { Service, Characteristic: C } = this.#api.hap;
    const scenario = this.#config.scenario;
    const allowed = [Service.AccessoryInformation.UUID, Service.Battery.UUID,
      ...(scenario === 'C' ? [] : [scenario === 'I' ? Service.Speaker.UUID : Service.SmartSpeaker.UUID])];
    if (accessory.services.some(service => !allowed.includes(service.UUID))
      || allowed.some(uuid => accessory.services.filter(service => service.UUID === uuid).length > 1)) {
      throw new Error('Unexpected synthetic services');
    }
    accessory.context = { fixture: '8a1', scenario };
    const information = accessory.getService(Service.AccessoryInformation);
    information.setCharacteristic(C.Manufacturer, 'Synthetic Fixture');
    information.setCharacteristic(C.Model, 'Presentation Experiment ' + scenario);
    information.setCharacteristic(C.SerialNumber, 'SYNTHETIC-8A1-' + scenario);
    information.setCharacteristic(C.FirmwareRevision, '0.0.1');
    information.setCharacteristic(C.Name, 'Synthetic Toniebox ' + scenario);
    // Homebridge's default Identify acknowledgement is inert; no physical action is installed.
    const battery = accessory.getService(Service.Battery) ?? accessory.addService(Service.Battery, 'Synthetic Battery');
    battery.setPrimaryService(scenario === 'C');
    const mode = this.#config.battery;
    const percent = { charging: 78, discharging: 64, low: 12 }[mode];
    this.#characteristic(battery, C.StatusLowBattery, mode === 'unknown' ? undefined
      : mode === 'low' ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    if (mode === 'unknown') {
      // Respect the host's required set; older HAP definitions may differ.
      const required = new Service.Battery();
      for (const type of [C.BatteryLevel, C.ChargingState]) {
        if (required.testCharacteristic(type)) {
          this.#characteristic(battery, type, undefined);
        } else if (battery.testCharacteristic(type)) {
          battery.removeCharacteristic(battery.getCharacteristic(type));
        }
      }
    } else {
      this.#characteristic(battery, C.BatteryLevel, percent);
      this.#characteristic(battery, C.ChargingState, mode === 'charging' ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING);
    }
    if (scenario === 'I') {
      this.#regularSpeaker(accessory, battery);
    } else if (scenario !== 'C') {
      const speaker = accessory.getService(Service.SmartSpeaker) ?? accessory.addService(Service.SmartSpeaker, 'Synthetic Toniebox ' + scenario);
      speaker.setPrimaryService(true);
      // AirPlay is always absent; only H exposes native synthetic Volume/Mute.
      for (const type of scenario === 'H' ? [C.AirPlayEnable] : [C.Volume, C.Mute, C.AirPlayEnable]) {
        if (speaker.testCharacteristic(type)) {
          speaker.removeCharacteristic(speaker.getCharacteristic(type));
        }
      }
      const media = { playing: C.CurrentMediaState.PLAY, paused: C.CurrentMediaState.PAUSE, 'no-media': C.CurrentMediaState.STOP };
      this.#media = media[this.#config.playback];
      this.#characteristic(speaker, C.CurrentMediaState, media[this.#config.playback]);
      // Synthetic desired state is fixed by configuration, never changed by a rejected write.
      this.#characteristic(speaker, C.TargetMediaState, media[this.#config.playback], true);
      this.#characteristic(speaker, C.ConfiguredName, 'Synthetic Toniebox ' + scenario, true);
      if (['D', 'E', 'F', 'G', 'H'].includes(scenario)) {
        // HAP's linking API does not check accessory membership itself.
        if (!accessory.services.includes(battery) || !accessory.services.includes(speaker)) {
          throw new Error('Synthetic service membership');
        }
        speaker.addLinkedService(battery);
      }
      if (['E', 'F', 'G', 'H'].includes(scenario)) {
        this.#controls(accessory, speaker);
      }
      if (scenario === 'H') {
        this.#audio(speaker);
      }
    }
  }

  start() {
    if (this.#started || this.#stopped) {
      return;
    }
    this.#started = true;
    try {
      const restored = this.#accessory !== undefined;
      const scenario = this.#config.scenario;
      const category = scenario === 'C' ? this.#api.hap.Categories.OTHER : this.#api.hap.Categories.SPEAKER;
      const accessory = this.#accessory ?? new this.#api.platformAccessory(
        'Synthetic Toniebox ' + scenario, fixtureUuid(this.#api, scenario), category,
      );
      this.#accessory = accessory;
      this.#configure(accessory);
      if (this.#stopped) {
        return;
      }
      if (externalScenarios.includes(scenario)) {
        this.#api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
      } else if (!restored) {
        this.#api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else {
        this.#api.updatePlatformAccessories([accessory]);
      }
      if (!this.#stopped) {
        this.#notice('Synthetic presentation fixture active. No Tonies backend or device commands.');
      }
    } catch {
      this.stop();
      this.#notice('Synthetic fixture stopped: presentation setup failed.');
    }
  }

  stop() {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    // Homebridge owns publication/socket teardown. Never unregister cached devices on shutdown.
    for (const [event, listener] of [['didFinishLaunching', this.#launch], ['shutdown', this.#shutdown]]) {
      if (listener) {
        try {
          this.#api.removeListener(event, listener);
        } catch {
          // Authority was already revoked; late events cannot restart this instance.
        }
      }
    }
  }
}

export default function register(api) {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PresentationPlatform);
}
