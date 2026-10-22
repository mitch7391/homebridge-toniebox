# homebridge-toniebox

Homebridge plugin for Toniebox devices, currently in development.

Increment 1 provides an inert platform shell and offline validation. It does not
authenticate with Tonies, discover devices, connect to MQTT, create accessories,
or control a Toniebox. Do not install it on a production Homebridge instance yet.
The package remains private.

## Development

Use a dedicated checkout and development branch. The runtime targets remain
Node.js `^22.10.0 || ^24.0.0` and Homebridge `^1.8.0 || ^2.0.0`.

Use current Node.js 22 (at least 22.13 for ESLint) or 24 for development; Node 24
is recommended. The development Homebridge types currently come from 2.x.
The mocked platform tests do not establish full Homebridge 1.x/2.x integration
compatibility.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm run typecheck
npm test
```

`npm test` builds the TypeScript source and runs Node's built-in test runner.
`npm run build` builds separately; `npm run test:offline` runs tests against
the existing build. Tests use a mocked Homebridge API and synthetic values.
They require no credentials, internet, broker, physical box or running Homebridge.
Dependencies must already be installed; installation itself may need registry access.

Lifecycle scripts are disabled during dependency installation because this
foundation needs none. There is no linking or automatic Homebridge launch script.
Validation never runs dependency fixes.

CI validates current Node 22/24 and separately tests compiled output on Node
22.10.0 and 24.0.0. Linux validation in a dedicated browser-based GitHub Codespace
remains the authoritative development gate; a Windows pass is reported separately.
Windows and Codespaces do not share filesystems: transfers require matching Git
baselines, a reviewed patch and file-integrity checks.

Text files use LF through `.gitattributes`; no global Git setting is required.

## Protocol evidence and scope

Read [the complete physical PoC handover](docs/toniebox-poc-handover.md), including
**DO NOT RETEST**, before implementing communications. Its verified physical
results must not be replaced with assumptions or repeated live experiments.

The approved later foundation uses memory-only rotating tokens, event-driven
MQTT state and per-topic snapshots. Healthy MQTT sessions survive token refresh.
MQTT.js will own reconnection. Device support follows capability evidence;
Classic and Lite behaviour must not be guessed.

The sequence is project cleanup, state/parsers, authentication, discovery, MQTT,
then coordination. Commands and HomeKit accessory design are outside Phase 1.

Never put credentials, tokens or personal account/device/content identifiers in
logs, test fixtures or diagnostic reports. Use synthetic fixtures.

Stop for review after each approved increment. Commits, pushes, pull requests,
publication and Raspberry Pi deployment require separate maintainer approval.
