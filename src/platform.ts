import { ProductionAccessories } from './productionAccessories.js';
import type { API, DynamicPlatformPlugin, Logging, PlatformConfig } from 'homebridge';
import { PlatformRuntime } from './platformRuntime.js';
import type { PlatformRuntimeOptions } from './platformRuntime.js';

/** Thin lifecycle adapter; production external presentation has separate ownership. */
export class TonieboxPlatform implements DynamicPlatformPlugin {
  constructor(log: Logging, config: PlatformConfig, api: API, options: PlatformRuntimeOptions = {}) {
    const runtime = new PlatformRuntime(config, log, { ...options,
      presentationFactory: options.presentationFactory ?? (reader => new ProductionAccessories(api, reader, message => log.warn(message))),
    });
    api.on('didFinishLaunching', () => runtime.launch());
    api.on('shutdown', () => runtime.stop());
  }

  configureAccessory(): void {
    // External accessories are rediscovered, not restored through this bridged-cache callback. Leave cached accessories untouched.
  }
}
