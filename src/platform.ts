import type { DynamicPlatformPlugin, Logging } from 'homebridge';

/**
 * Inert platform shell. Communications and accessory mapping follow separately.
 */
export class TonieboxPlatform implements DynamicPlatformPlugin {
  constructor(log: Logging) {
    log.info('Toniebox foundation loaded; device integration is not implemented yet.');
  }

  configureAccessory(): void {
    // Leave restored accessories unchanged until accessory support is designed.
  }
}
