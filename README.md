# homebridge-toniebox

A Homebridge plugin in development, aiming to bring Toniebox devices into Apple Home.

> 🚧 **Early development — not ready for installation.**
>
> This project is currently establishing its foundations. Toniebox integration and HomeKit accessories are not yet implemented.

## Project Status

**Increment 1 — Foundation: Complete ✅**

The initial foundation includes:

- A minimal Homebridge dynamic platform.
- Cleanup of unused template code and dependencies.
- Automated offline tests for platform registration and lifecycle behaviour.
- Validation across Node.js 22 and 24.

The plugin does not currently authenticate with Tonies, discover devices, connect to MQTT, create HomeKit accessories or control a Toniebox.

## Development Roadmap

Development will progress incrementally through:

1. **Foundation** — Project setup, cleanup and validation. ✅
2. **State Management** — MQTT topic parsing and device-state modelling.
3. **Authentication** — Tonies Cloud authentication and token management.
4. **Device Discovery** — Household and Toniebox discovery.
5. **MQTT Integration** — Event-driven device communication.
6. **Integration** — Bringing the components together.

HomeKit accessories and device controls will follow once the underlying integration is sufficiently mature.

Initial protocol research has been carried out using a **Toniebox 2**. Support for other models, including Toniebox Classic and Lite, will depend on verified capabilities and testing.

## Development

The project currently targets:

- **Node.js:** `^22.10.0 || ^24.0.0`
- **Homebridge:** `^1.8.0 || ^2.0.0`

Node.js 24 is recommended for development. Node.js 22.13.0 or newer is required for the current ESLint tooling.

To build and validate locally:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm run typecheck
npm test
```

Tests use mocked Homebridge interfaces and synthetic data. No Toniebox, account credentials or running Homebridge instance is required.

Compatibility testing against running Homebridge 1.x and 2.x installations is still pending.

## Protocol Research

The project builds on an initial physical proof of concept exploring Tonies Cloud authentication, device discovery and MQTT communication.

The findings and implementation considerations are documented in the [Toniebox PoC handover](docs/toniebox-poc-handover.md).

## Contributing and Testing

The project is in early development, but interest, feedback and future beta testing are welcome.

If you own a Toniebox and would like to follow development or help test future releases, watch this repository for updates.

**Please do not share account credentials, authentication tokens or personal device identifiers in issues or discussions.**

---

*This is an independent, unofficial project and is not affiliated with or endorsed by tonies®.*
