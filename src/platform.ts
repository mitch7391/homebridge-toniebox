import type { API, DynamicPlatformPlugin, Logging, PlatformConfig } from 'homebridge';
import { PlatformRuntime } from './platformRuntime.js';
import type { PlatformRuntimeOptions } from './platformRuntime.js';

/** Thin lifecycle adapter. Accessory support remains intentionally absent. */
export class TonieboxPlatform implements DynamicPlatformPlugin {
  constructor(log: Logging, config: PlatformConfig, api: API, options: PlatformRuntimeOptions = {}) {
    const runtime = new PlatformRuntime(config, log, options);
    api.on('didFinishLaunching', () => runtime.launch());
    api.on('shutdown', () => runtime.stop());
  }

  configureAccessory(): void {
    // Leave restored accessories unchanged until accessory support is designed.
  }
}
