<p align="center">
  <img src="docs/assets/homebridge-toniebox-logo.png" alt="Homebridge Toniebox" width="260">
</p>

<h1 align="center">Homebridge Toniebox</h1>

<p align="center">
  Bringing Toniebox into Apple Home.
</p>

<p align="center">
  <a href="https://github.com/mitch7391/homebridge-toniebox/actions/workflows/build.yml"><img src="https://github.com/mitch7391/homebridge-toniebox/actions/workflows/build.yml/badge.svg?branch=latest" alt="Build Status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://www.paypal.com/donate/?business=FWN5P4BP7NJT4&amp;no_recurring=1&amp;item_name=Shout+me+a+coffee+%3A%29&amp;currency_code=AUD"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Donate-orange" alt="Buy Me a Coffee"></a>
</p>

> [!IMPORTANT]
> **This plugin is currently under development and is not ready for installation.**
>
> The foundations are in place, but live Toniebox connectivity and Apple Home integration are still being developed. You're welcome to follow along as the project progresses!

**Homebridge Toniebox** is an independent project aiming to bring the Toniebox into the smart home through Homebridge.

The idea is simple: create a reliable, responsive integration that makes the Toniebox feel like a natural part of Apple Home.

From managing playback and volume to checking battery levels or setting a sleep timer, there's plenty of potential to explore.

I've started this project after experimenting with my own Toniebox 2 and discovering just how much functionality is available behind the scenes.

Rather than rushing something out that only works half the time, I'm building the plugin in stages, focusing on getting the foundations right before introducing live control and HomeKit accessories.

## What Can It Do?

Initial research with Toniebox 2 has demonstrated some promising capabilities:

- **Playback control:** Play, pause and navigate chapters.
- **Volume control:** Adjust the Toniebox volume remotely.
- **Now playing:** Identify the current Tonie and follow playback progress.
- **Battery monitoring:** View battery level and charging status.
- **Headphone information:** Monitor audio-output status.
- **Sleep timer:** View, set and cancel the bedtime timer.
- **Device settings:** Access supported Toniebox configuration options.

These features have been demonstrated through a separate proof of concept, not through the Homebridge plugin itself.

Which capabilities ultimately appear in Apple Home will depend on the accessory design and what HomeKit can sensibly support.

I would much rather provide a handful of well-designed accessories than force everything into unsuitable HomeKit categories.

## Development Progress

The plugin is being developed in smaller increments, with each stage tested and reviewed before moving on.

### ✅ Increment 1 - Foundation (Complete)

The initial Homebridge platform is now in place.

This includes plugin registration, configuration structure, lifecycle handling and automated testing. The platform deliberately remains inactive until the underlying integration is ready.

### ✅ Increment 2 - MQTT Parsing and State Management (Complete)

The first Toniebox-specific components are now implemented.

The plugin can interpret seven documented MQTT state topics and maintain a local device-state model, including playback, battery, volume, headphone information and sleep timer state.

This also includes safeguards for retained MQTT messages, reconnecting sessions and stale device information.

### ✅ Increment 3A - Authentication Client (Complete)

The first part of the Tonies Cloud authentication system is now implemented.

A standalone authentication client supports signing in with account credentials and renewing access through refresh tokens. It includes validation of authentication responses, safe handling of token rotation, request timeouts and cancellation, and safeguards against exposing sensitive information.

Importantly, this is still an independent component. It is not yet connected to the Homebridge platform, and the plugin does not automatically sign in, store tokens or communicate with a Toniebox.

At the completion of Increment 3A, the project passed **68 automated offline tests**, including 34 new tests covering authentication.

### ✅ Increment 3B - Token Lifecycle Management (Complete)

The second part of the Tonies Cloud authentication system is now implemented.

An account-scoped token manager handles authentication tokens in memory, tracks expiry, and coordinates login and token renewal without unnecessary requests. It supports proactive and on-demand renewal, safe refresh-token rotation, and controlled recovery from temporary connection or authentication failures.

The manager also protects against overlapping authentication requests, stale responses, excessive retries and accidental exposure of sensitive information.

Like Increment 3A, this remains an independent component. It is not yet connected to the Homebridge platform, does not automatically communicate with Tonies Cloud, and does not persist authentication tokens across restarts.

The project now passes **140 automated offline tests**, including **72 new tests** covering token lifecycle management.

## Roadmap

Here's the current plan for development:

- [x] **Increment 1:** Homebridge foundation
- [x] **Increment 2:** MQTT parsing and device-state management
- [x] **Increment 3:** Authentication and token lifecycle
  - [x] **3A:** Stateless authentication client
  - [x] **3B:** Token lifecycle management
- [ ] **Increment 4:** Household and device discovery
- [ ] **Increment 5:** MQTT connectivity and reconnection
- [ ] **Increment 6:** Backend coordination and integration
- [ ] **Future:** HomeKit accessories and controls
- [ ] **Future:** Beta testing and refinement

The roadmap is subject to change as development progresses.

## How Will It Work?

One of the most exciting discoveries during the initial research was that Toniebox 2 can communicate through MQTT, rather than requiring constant requests to check what the device is doing.

That gives us the opportunity to build something much more responsive and efficient.

The planned integration combines:

- **MQTT** for live device state and commands.
- **REST / GraphQL** for discovering devices, retrieving metadata and changing persistent settings.
- **Local state management** for keeping track of playback, timers and device availability.

The goal is to minimise unnecessary network traffic while keeping the experience in Apple Home responsive and reliable.

## Installation

**Not available yet.**

The plugin has not been published to npm and is not currently suitable for use on a production Homebridge installation.

Installation and configuration instructions will be provided when the integration reaches a usable testing stage.

## Development and Testing

The project currently declares support for the following environments:

| Component | Version |
|---|---|
| Node.js | `^22.10.0 \|\| ^24.0.0` |
| Homebridge | `^1.8.0 \|\| ^2.0.0` |

Node.js 24 is recommended for development. Node.js 22.13.0 or newer is needed for the current ESLint development tooling.

Compatibility with running Homebridge installations still needs to be validated.

### Building from source

Install the development dependencies:

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

Run the validation suite:

```bash
npm run lint
npm run typecheck
npm test
```

Automated GitHub Actions workflows validate the project across Node.js 22 and 24, including minimum supported runtime checks.

All tests currently run offline using synthetic data and mocked Homebridge interfaces. No Toniebox hardware, Tonies account or MQTT connection is required.

### Technical Documentation

Before developing the plugin, I carried out an extensive proof of concept using Toniebox 2 to understand the available functionality and communication protocols.

The results have been documented in the [Toniebox Proof of Concept Handover](docs/toniebox-poc-handover.md).

This provides the technical foundation for future development and helps avoid repeating experiments that have already been completed.

Initial development is focused on **Toniebox 2**. Compatibility with other generations will require additional verification.

## Feedback and Contributions

Interested in bringing your Toniebox into Apple Home too?

I'd love to hear your thoughts!

Feel free to ⭐ the repository or watch it to follow development, or [open an issue](https://github.com/mitch7391/homebridge-toniebox/issues) with suggestions, ideas or feedback.

As the integration develops, I'll also be looking for people interested in helping test it with their own Toniebox devices.

Please avoid sharing account credentials, authentication tokens or private device identifiers in issues or diagnostic logs.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

## Disclaimer

Homebridge Toniebox is an independent, unofficial project and is not affiliated with, endorsed by or supported by tonies®.
