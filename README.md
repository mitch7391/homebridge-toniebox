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
> The Homebridge backend has been implemented and successfully tested against Tonies Cloud in a controlled Raspberry Pi commissioning environment. HomeKit accessories, device controls and broader reliability testing are still under development. You're welcome to follow along as the project progresses!

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

### ✅ Increment 4A - Stateless REST Discovery Client (Complete)

The first part of household and device discovery is now implemented.

A standalone REST client supports retrieving account information, enumerating households and discovering Tonieboxes. It validates responses defensively, preserves valid devices when other records are malformed, and retains unfamiliar device models, generations and capabilities.

The client also identifies ambiguous device routing information, supports request timeouts and cancellation, and provides privacy-safe error handling.

The REST client itself remains stateless, while the separate Increment 4B runner now combines it with token management. Neither component is connected to the Homebridge platform, so the plugin does not automatically discover devices or establish live Toniebox connectivity.

At the completion of Increment 4A, the project passed **211 automated offline tests**, including **71 new tests** covering REST discovery.

### ✅ Increment 4B - Token-Managed Discovery Orchestration (Complete)

The second part of household and device discovery is now implemented.

A standalone discovery runner brings together the existing token manager and REST discovery client, allowing account information, households and Tonieboxes to be discovered through a coordinated process.

Each discovery run uses a single access token, retrieves household and device information sequentially, and operates within defined time limits. It also handles temporary connection failures conservatively, respects cloud rate limits, and preserves partial discovery results when enumeration cannot be completed.

Additional safeguards protect against overlapping discovery operations, outdated responses, duplicate device identities and ambiguous routing information. Cancellation and shutdown are handled without allowing previous discovery results to affect a new account session.

The discovery runner remains an independent component. It is not yet connected to the Homebridge platform, and the plugin does not automatically sign in, discover Tonieboxes, establish MQTT connections or create HomeKit accessories.

The project now passes **331 automated offline tests**, including **120 new tests** covering discovery orchestration.

This completes Increment 4, establishing the foundation for account-scoped household and device discovery ahead of live MQTT connectivity.

### ✅ Increment 5A - Guarded MQTT Transport and Subscriptions (Complete)

The first part of live MQTT connectivity is now implemented.

A standalone MQTT v5 transport supports authenticated, secure WebSocket connections to Tonies Cloud and subscribes to the seven documented state topics for each approved Toniebox. It validates connection and subscription acknowledgements before reporting readiness, preserves early messages within defined limits, and handles timeouts, cancellation and cleanup.

Additional safeguards protect against oversized MQTT packets before decoding, excessive payloads and uncontrolled message buffering. Automatic reconnection, resubscription and command publishing remain disabled.

The transport itself remains standalone and is not connected directly to Homebridge or the token manager. Increment 5B now composes it with the token manager, while Homebridge integration remains future work.

The project now passes **432 automated offline tests**, including **101 new tests** covering MQTT transport and subscriptions. Testing also passed on Linux across the supported Node.js versions.

**Diagnostic logging and privacy:** The transport avoids exposing sensitive information in normal diagnostic logs. A known limitation in the underlying MQTT library means dynamically enabled low-level packet tracing may include private connection or device information in process logs. Avoid enabling MQTT packet tracing and review logs before sharing them. An upstream improvement is being tracked in [mqtt-packet issue #165](https://github.com/mqttjs/mqtt-packet/issues/165).

### ✅ Increment 5B - Token-Managed MQTT Lifecycle and Reconnection (Complete)

The second part of MQTT connectivity is now implemented.

A standalone MQTT lifecycle component coordinates the existing token manager and guarded MQTT transport. It acquires usable access tokens for each connection attempt and automatically reconnects after temporary failures using bounded backoff and jitter. The original implementation deliberately avoided restarting healthy MQTT connections solely because an access token was renewed.

Subsequent live commissioning demonstrated that Tonies Cloud could reject an established MQTT connection when its original access credential expired. Increment 7A.2 therefore introduced controlled connection replacement when new access credentials are adopted, superseding that earlier behaviour.

The lifecycle also manages MQTT session generations, protects against stale callbacks and messages, and handles cancellation, shutdown and connection failures conservatively. Definitive MQTT authentication refusal requires attention rather than repeatedly retrying rejected credentials.

This remains an independent backend component. It is not yet connected to the Homebridge platform, and the plugin does not automatically discover Tonieboxes, establish live connections or create HomeKit accessories.

The project now passes **571 automated offline tests**, including **139 new tests** covering MQTT lifecycle management and reconnection. Validation also passed on Linux across the supported Node.js versions and minimum runtimes.

This completes Increment 5, providing the foundation for reliable MQTT connectivity ahead of backend integration.

### ✅ Increment 6A - Device Routing and State Integration (Complete)

The first part of backend integration is now implemented.

A standalone routing and compatibility layer determines which discovered Tonieboxes are eligible for MQTT connectivity. The initial compatibility profile supports Toniebox 2 based on the documented reference-device evidence, while Toniebox Classic and Lite remain unverified and require explicit experimental authorisation before testing.

Route approval validates account identity, household association, device identifiers, MAC addresses and compatibility evidence. Experimental devices are isolated from established production routing to avoid compromising known-good connections.

Route reconciliation also protects existing connections against temporary discovery failures and incomplete metadata. Previously approved devices can retain last-known routing authority when there is no confirmed reason to disconnect them, while explicit restrictions, account invalidation, identity conflicts and authoritative device absence remain effective.

A separate backend-state adapter integrates MQTT lifecycle events with the existing device-state model. It protects against stale sessions and callbacks, preserves valid state across reconnects, and exposes connection and attention-required status for future backend coordination.

These components remain independent of the Homebridge platform. They do not automatically authenticate, discover devices, establish MQTT connections or create HomeKit accessories.

The project now passes **775 automated offline tests**, including **204 new tests** covering device routing, compatibility, reconciliation and backend-state integration. Validation also passed on Linux across the supported Node.js versions and minimum runtimes.

Increment 6B will connect these standalone components through an account coordinator, followed by Homebridge platform integration in Increment 6C.

### ✅ Increment 6B - Account Coordination and Lifecycle Management (Complete)

The second part of backend integration is now implemented.

A standalone account coordinator brings together the existing authentication, discovery, routing, MQTT lifecycle and device-state components. It manages account credentials, coordinates discovery and controls authorised MQTT connections without duplicating the responsibilities of the underlying components.

Account-context isolation protects against outdated discovery results, stale MQTT callbacks and credential changes. Previously authorised production connections can remain operational during temporary discovery failures, while confirmed account, routing and compatibility changes invalidate obsolete authority.

The coordinator also preserves cloud rate-limit cooldowns across context replacements and avoids unnecessary MQTT restarts when device routing remains unchanged.

Experimental Toniebox models are managed through separate connections and state adapters, isolated from production devices. A conservative limit of four experimental connections per account prevents uncontrolled resource consumption without arbitrarily selecting devices from an oversized set.

Privacy-safe diagnostics expose connection status, discovery health and conditions requiring attention without revealing account credentials, tokens or private device identifiers.

The coordinator remains independent of the Homebridge platform. Discovery is explicitly requested, and no HomeKit accessories or device commands are implemented yet.

The project now passes **827 automated offline tests**, including **52 new tests** covering account coordination, credential transitions, discovery recovery, routing lifecycle management and experimental isolation. Validation also passed on Linux across the supported Node.js versions and minimum runtimes.

This completes Increment 6B. Increment 6C will connect the standalone backend to Homebridge, including configuration, startup and shutdown handling.

### ✅ Increment 6C - Homebridge Platform Integration (Complete)

The final part of backend integration is now implemented.

The existing Toniebox account coordinator is now connected to the Homebridge platform lifecycle. The plugin can accept configured Tonies account credentials, initialise the backend after Homebridge finishes launching, and automatically begin device discovery and authorised MQTT connectivity.

Startup remains non-blocking, allowing Homebridge to operate normally while authentication and discovery take place. Missing or invalid credentials leave the backend safely inactive without attempting network communication.

A dedicated platform runtime manages discovery recovery using the coordinator's sanitised recovery advice. Temporary failures are retried using bounded backoff, jitter and existing cloud rate-limit protections. Successful discovery ends the recovery sequence without introducing continuous REST polling.

The integration also provides controlled shutdown, cancellation and protection against stale callbacks or asynchronous operations continuing after the backend has stopped.

Privacy-safe operational logging reports discovery progress, connection status and conditions requiring attention. Production and experimental connectivity are reported independently to avoid misrepresenting healthy connections.

Existing HomeKit accessory behaviour remains unchanged. The plugin does not yet create accessories, expose HomeKit controls or publish device commands.

The project now passes **928 automated offline tests**, including **101 new tests across Increment 6C** covering discovery recovery, Homebridge startup, configuration validation, lifecycle management, cancellation, diagnostics and shutdown. Validation also passed on Linux across the supported Node.js versions and minimum runtimes.

This completes Increment 6, establishing the Homebridge backend integration required for future HomeKit accessories and device controls.

Live Tonies Cloud connectivity was subsequently validated through Increment 7A. Further reliability testing and HomeKit accessory development remain necessary before the plugin is suitable for beta use.

### ✅ Increment 7A.1 - Opt-in Commissioning Diagnostics (Complete)

The first part of live backend commissioning introduced a passive, opt-in diagnostic observer for validating the existing integration against real Tonies Cloud connections.

The observer provides privacy-safe summaries of account discovery, household and device coverage, routing eligibility, MQTT session establishments and device-state processing. It distinguishes production and experimental connections, accepted and rejected messages, retained and live updates, and coverage across the seven supported MQTT state categories.

Diagnostic observations are bounded and protected against stale account contexts, expired sessions and observer failures. They do not introduce additional cloud requests, MQTT subscriptions or device commands.

Commissioning diagnostics are disabled in the committed source through `COMMISSIONING_BUILD = false` and can only be enabled in a separately prepared commissioning build.

Increment 7A.1 passed automated offline validation and enabled the first controlled Raspberry Pi commissioning runs.

Those initial live tests successfully established Tonies Cloud connectivity but revealed a reproducible MQTT authentication failure approximately five minutes after connection establishment. Further investigation showed that access credentials were being renewed while the existing MQTT connection continued using its original authentication credentials.

This finding led directly to Increment 7A.2.

### ✅ Increment 7A.2 - MQTT Credential Renewal and Recovery (Complete)

The second part of live backend commissioning addresses the MQTT authentication lifecycle issue identified during Increment 7A.1.

The token manager now tracks revisions of adopted access credentials and provides controlled notifications when credentials change. The MQTT lifecycle uses these revisions to replace established connections proactively, allowing a new connection to authenticate using the updated credential before the previous credential expires.

Connection replacement preserves existing account ownership and authorised device routing while protecting against stale callbacks, obsolete session authority, overlapping connection attempts and reuse of rejected credentials.

The implementation also introduces revision-gated recovery for qualifying broker authentication failures, including post-ready MQTT DISCONNECT reason code 135. Recovery is constrained by existing authentication, retry, cooldown and terminal-attention safeguards rather than repeatedly reconnecting with credentials already known to have been refused.

Additional privacy-safe commissioning observations distinguish credential renewal, proactive connection replacement and recovery activity without exposing authentication tokens or private device identifiers.

#### Live Raspberry Pi commissioning

On 6 November 2026, Increment 7A.2 was tested against the real Tonies Cloud service using an isolated Homebridge instance on a Raspberry Pi running Node.js 24.22.2.

The approximately 30-minute commissioning run recorded:

- **8 successfully established production MQTT sessions.**
- **7 consecutive successful credential-driven connection replacements.**
- **8 access-credential adoption/change observations**, including the initial credential adoption.
- **0 observed lifecycle retry events.**
- **0 terminal authentication attention events.**
- **0 error or warning keyword matches** in the final log screening.

Every observed proactive replacement progressed through connection establishment to MQTT readiness.

The commissioning process exited, its dedicated Homebridge port was released, and the existing production Homebridge service remained active.

The original approximately five-minute authentication failure did not recur during this test.

This satisfies the primary live credential-rotation commissioning objective. It does not establish indefinite reliability or complete coverage of all failure scenarios.

In particular, reactive recovery from broker DISCONNECT reason code 135 has automated offline test coverage but has not been exercised against the live broker. Multi-day unattended stability also remains to be validated.

#### Validation

Increment 7A.2 passed **1,028 automated offline tests** on Windows and Raspberry Pi Linux.

TypeScript type-checking, ESLint and the production build also passed.

GitHub Actions validation completed successfully on:

- Node.js 22.x
- Node.js 24.x
- Minimum supported Node.js 22.10.0
- Minimum supported Node.js 24.0.0

The automated tests use controlled offline fixtures and mocked dependencies. The separate Raspberry Pi commissioning run provides real-world connectivity evidence.

Commissioning diagnostics remain disabled in committed source, and the plugin still does not create HomeKit accessories or publish device commands.

This completes Increment 7A, establishing a live-validated backend foundation for future HomeKit accessory development.

### ✅ Increment 8A - HomeKit Presentation Research (Complete)

The first stage of HomeKit accessory development is now complete.

Nine isolated synthetic scenarios were developed to investigate how Toniebox functionality could be represented in Apple Home, including speaker presentation, playback control, volume adjustment and battery reporting.

Manual testing with Apple Home, Siri and Eve revealed an important distinction between HomeKit's supported characteristics and the controls Apple's Home app actually exposes. For example, an externally published SmartSpeaker provides a recognisable speaker identity and playback status, but Apple's Home app does not expose usable direct native playback or volume controls. Native playback and volume commands can nevertheless be issued through supported HomeKit scene actions, while a dedicated Playback Switch offers practical direct Play/Pause control in Apple Home and through Siri.

The research established the initial presentation direction:

- **SmartSpeaker:** Speaker identity, playback feedback and native playback and volume scene actions.
- **Playback Switch:** Direct Play/Pause control through Apple Home and Siri.
- **Linked Battery:** Battery level and charging telemetry using genuine device state.

A separate Lightbulb-based volume slider remains a possible future enhancement, **opt-in and disabled by default**, for users who want direct volume adjustment in Apple Home. The regular Speaker was not selected because Apple Home did not expose its volume controls. A combined Speaker/SmartSpeaker arrangement was considered but not tested, as its expected benefit would require a third-party HomeKit app and introduce additional complexity.

The isolated presentation fixture passed **122 automated offline tests**. Findings from the nine scenarios and their limitations are documented in the [HomeKit Presentation Research](experiments/homekit-presentation/FINDINGS.md), separately from the synthetic [fixture and test procedures](experiments/homekit-presentation/README.md).

This completes the presentation research stage, not production HomeKit integration. The plugin still does not create live Toniebox accessories or expose physical-device controls. Increment 8B.1 has since established the initial backend-to-HomeKit integration contract; accessory publication remains future work.

### ✅ Increment 8B.1 - Production HomeKit Integration Contract (Complete)

The first stage of production HomeKit integration is now complete.

The account coordinator now provides a read-only inventory of authorised production Tonieboxes and event-driven notifications for device, routing and connection-state changes.

The integration preserves existing account and MQTT session authority, distinguishes current from last-known routing information, and prevents stale or revoked connections from supplying authoritative updates. Experimental devices remain isolated from production HomeKit presentation.

Increment 8B.1 passed **1,181 automated offline tests**, including **31 new regression tests**. Validation also passed across the supported Node.js 22 and 24 runtimes.

This establishes the interface required for future HomeKit accessories. The plugin does not yet publish production accessories or provide physical-device controls.

## Roadmap

Here's the current plan for development:

- [x] **Increment 1:** Homebridge foundation
- [x] **Increment 2:** MQTT parsing and device-state management
- [x] **Increment 3:** Authentication and token lifecycle
  - [x] **3A:** Stateless authentication client
  - [x] **3B:** Token lifecycle management
- [x] **Increment 4:** Household and device discovery
  - [x] **4A:** Stateless REST discovery client
  - [x] **4B:** Token-managed discovery orchestration
- [x] **Increment 5:** MQTT connectivity and reconnection
  - [x] **5A:** Guarded MQTT transport and subscriptions
  - [x] **5B:** Token-managed connection lifecycle and reconnection
- [x] **Increment 6:** Backend coordination and integration
  - [x] **6A:** Device routing and state integration
  - [x] **6B:** Account coordination and lifecycle management
  - [x] **6C:** Homebridge platform integration
- [x] **Increment 7A:** Live backend commissioning and MQTT reliability
  - [x] **7A.1:** Opt-in commissioning diagnostics
  - [x] **7A.2:** MQTT credential renewal and recovery
- [x] **Increment 8A:** HomeKit presentation research
- [ ] **Increment 8B:** Production HomeKit architecture discovery and accessory integration
  - [x] **8B.1:** Production device inventory and change notifications
  - [ ] **8B.2:** External SmartSpeaker lifecycle and read-only presentation
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

The backend has been validated in an isolated Raspberry Pi Homebridge environment. General installation compatibility, HomeKit accessory behaviour and longer-term unattended operation remain to be validated.

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

Automated tests run offline using synthetic data, controlled fixtures and mocked Homebridge interfaces. No Toniebox hardware, Tonies account or live MQTT connection is required to execute the test suite.

Separate manual commissioning has also validated the backend against a real Toniebox 2 and Tonies Cloud, as documented in Increment 7A. These results should not be confused with the automated GitHub Actions tests.

### Technical Documentation

Before developing the plugin, I carried out an extensive proof of concept using Toniebox 2 to understand the available functionality and communication protocols.

The results have been documented in the [Toniebox Proof of Concept Handover](docs/toniebox-poc-handover.md).

This provides the technical foundation for future development and helps avoid repeating experiments that have already been completed.

The [Discovery API Evidence](docs/discovery-api-evidence.md) also records the observed REST discovery behaviour, implementation decisions and remaining API uncertainties.

The [HomeKit Presentation Research](experiments/homekit-presentation/FINDINGS.md) records the synthetic A–I accessory experiments, Apple Home/Siri/Eve observations and the initial presentation design chosen ahead of production integration.

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
