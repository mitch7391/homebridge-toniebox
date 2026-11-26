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
> The Homebridge backend has been implemented and successfully tested against Tonies Cloud in a controlled Raspberry Pi commissioning environment. The first external read-only HomeKit SmartSpeaker has also been physically commissioned, bringing playback state into Apple Home. Further controls, broader functionality and long-term reliability testing remain under development. You're welcome to follow along as the project progresses!

**Homebridge Toniebox** is an independent project aiming to bring the Toniebox into the smart home through Homebridge.

The idea is simple: create a reliable, responsive integration that makes the Toniebox feel like a natural part of Apple Home.

From managing playback and volume to checking battery levels or setting a sleep timer, there's plenty of potential to explore.

I've started this project after experimenting with my own Toniebox 2 and discovering just how much functionality is available behind the scenes.

Rather than rushing something out that only works half the time, I'm building the plugin in stages, building on the backend and first read-only HomeKit accessory before introducing device controls.

## What Can It Do?

The Homebridge plugin currently provides:

- Authorised production Toniebox discovery and backend integration.
- MQTT device-state observation without continuous REST polling.
- An external read-only HomeKit SmartSpeaker reporting Playing, Paused and Stopped.
- Playback recovery using usable current-session MQTT evidence, including retained snapshots, across ordinary connection replacement and isolated Homebridge restarts.

Writable playback commands, a dedicated Playback Switch, native playback scene actions, volume control, battery and charging presentation, headphone status, sleep timer controls and other device settings are not yet available as production HomeKit controls or telemetry.

Increment 8B.3A established guarded MQTT playback-command publishing. Increment 8B.3B now connects this transport to authorised lifecycle and account coordination, including bounded physical-state confirmation. Publishing remains disabled by default, and no writable HomeKit controls are exposed.

Separately, initial research with Toniebox 2 demonstrated these proof-of-concept capabilities:

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

This includes plugin registration, configuration structure, lifecycle handling and automated testing. At this stage, the platform deliberately remained inactive until the underlying integration was ready.

### ✅ Increment 2 - MQTT Parsing and State Management (Complete)

The first Toniebox-specific components are now implemented.

The plugin can interpret seven documented MQTT state topics and maintain a local device-state model, including playback, battery, volume, headphone information and sleep timer state.

This also includes safeguards for retained MQTT messages, reconnecting sessions and stale device information.

### ✅ Increment 3A - Authentication Client (Complete)

The first part of the Tonies Cloud authentication system is now implemented.

A standalone authentication client supports signing in with account credentials and renewing access through refresh tokens. It includes validation of authentication responses, safe handling of token rotation, request timeouts and cancellation, and safeguards against exposing sensitive information.

At the completion of Increment 3A, this was an independent component, not yet connected to the Homebridge platform. It did not automatically sign in, persist tokens or communicate with a Toniebox.

At the completion of Increment 3A, the project passed **68 automated offline tests**, including 34 new tests covering authentication.

### ✅ Increment 3B - Token Lifecycle Management (Complete)

The second part of the Tonies Cloud authentication system is now implemented.

An account-scoped token manager handles authentication tokens in memory, tracks expiry, and coordinates login and token renewal without unnecessary requests. It supports proactive and on-demand renewal, safe refresh-token rotation, and controlled recovery from temporary connection or authentication failures.

The manager also protects against overlapping authentication requests, stale responses, excessive retries and accidental exposure of sensitive information.

Like Increment 3A, this was initially an independent component, not yet connected to Homebridge. It does not persist authentication tokens across restarts.

The project now passes **140 automated offline tests**, including **72 new tests** covering token lifecycle management.

### ✅ Increment 4A - Stateless REST Discovery Client (Complete)

The first part of household and device discovery is now implemented.

A standalone REST client supports retrieving account information, enumerating households and discovering Tonieboxes. It validates responses defensively, preserves valid devices when other records are malformed, and retains unfamiliar device models, generations and capabilities.

The client also identifies ambiguous device routing information, supports request timeouts and cancellation, and provides privacy-safe error handling.

The REST client itself remains stateless, while the separate Increment 4B runner now combines it with token management. At that stage, neither component was connected to Homebridge; automatic discovery and live connectivity followed in Increment 6C.

At the completion of Increment 4A, the project passed **211 automated offline tests**, including **71 new tests** covering REST discovery.

### ✅ Increment 4B - Token-Managed Discovery Orchestration (Complete)

The second part of household and device discovery is now implemented.

A standalone discovery runner brings together the existing token manager and REST discovery client, allowing account information, households and Tonieboxes to be discovered through a coordinated process.

Each discovery run uses a single access token, retrieves household and device information sequentially, and operates within defined time limits. It also handles temporary connection failures conservatively, respects cloud rate limits, and preserves partial discovery results when enumeration cannot be completed.

Additional safeguards protect against overlapping discovery operations, outdated responses, stale MQTT callbacks, credential changes, duplicate device identities and ambiguous routing information. Cancellation and shutdown are handled without allowing previous discovery results to affect a new account session.

Increment 4B delivered an independent discovery runner. Homebridge startup integration and accessory publication followed in later increments.

The project now passes **331 automated offline tests**, including **120 new tests** covering discovery orchestration.

This completes Increment 4, establishing the foundation for account-scoped household and device discovery ahead of live MQTT connectivity.

### ✅ Increment 5A - Guarded MQTT Transport and Subscriptions (Complete)

The first part of live MQTT connectivity is now implemented.

A standalone MQTT v5 transport supports authenticated, secure WebSocket connections to Tonies Cloud and subscribes to the seven documented state topics for each approved Toniebox. It validates connection and subscription acknowledgements before reporting readiness, preserves early messages within defined limits, and handles timeouts, cancellation and cleanup.

Additional safeguards protect against oversized MQTT packets before decoding, excessive payloads and uncontrolled message buffering. Automatic reconnection, resubscription and command publishing remain disabled.

The transport itself remains standalone and is not connected directly to Homebridge or the token manager. Increment 5B now composes it with the token manager, with Homebridge integration subsequently added in Increment 6C.

The project now passes **432 automated offline tests**, including **101 new tests** covering MQTT transport and subscriptions. Testing also passed on Linux across the supported Node.js versions.

**Diagnostic logging and privacy:** The transport avoids exposing sensitive information in normal diagnostic logs. A known limitation in the underlying MQTT library means dynamically enabled low-level packet tracing may include private connection or device information in process logs. Avoid enabling MQTT packet tracing and review logs before sharing them. An upstream improvement is being tracked in [mqtt-packet issue #165](https://github.com/mqttjs/mqtt-packet/issues/165).

### ✅ Increment 5B - Token-Managed MQTT Lifecycle and Reconnection (Complete)

The second part of MQTT connectivity is now implemented.

A standalone MQTT lifecycle component coordinates the existing token manager and guarded MQTT transport. It acquires usable access tokens for each connection attempt and automatically reconnects after temporary failures using bounded backoff and jitter. The original implementation deliberately avoided restarting healthy MQTT connections solely because an access token was renewed.

Subsequent live commissioning demonstrated that Tonies Cloud could reject an established MQTT connection when its original access credential expired. Increment 7A.2 therefore introduced controlled connection replacement when new access credentials are adopted, superseding that earlier behaviour.

The lifecycle also manages MQTT session generations, protects against stale callbacks and messages, and handles cancellation, shutdown and connection failures conservatively. Definitive MQTT authentication refusal requires attention rather than repeatedly retrying rejected credentials.

Increment 5B delivered an independent backend component; Homebridge integration and accessory publication followed in later increments.

The project now passes **571 automated offline tests**, including **139 new tests** covering MQTT lifecycle management and reconnection. Validation also passed on Linux across the supported Node.js versions and minimum runtimes.

This completes Increment 5, providing the foundation for reliable MQTT connectivity ahead of backend integration.

### ✅ Increment 6A - Device Routing and State Integration (Complete)

The first part of backend integration is now implemented.

A standalone routing and compatibility layer determines which discovered Tonieboxes are eligible for MQTT connectivity. The initial compatibility profile supports Toniebox 2 based on the documented reference-device evidence, while Toniebox Classic and Lite remain unverified and require explicit experimental authorisation before testing.

Route approval validates account identity, household association, device identifiers, MAC addresses and compatibility evidence. Experimental devices are isolated from established production routing to avoid compromising known-good connections.

Route reconciliation also protects existing connections against temporary discovery failures and incomplete metadata. Previously approved devices can retain last-known routing authority when there is no confirmed reason to disconnect them, while explicit restrictions, account invalidation, identity conflicts and authoritative device absence remain effective.

A separate backend-state adapter integrates MQTT lifecycle events with the existing device-state model. It protects against stale sessions and callbacks, preserves valid state across reconnects, and exposes connection and attention-required status for future backend coordination.

Increment 6A delivered standalone components without Homebridge startup or accessory ownership.

The project now passes **775 automated offline tests**, including **204 new tests** covering device routing, compatibility, reconciliation and backend-state integration. Validation also passed on Linux across the supported Node.js versions and minimum runtimes.

Increment 6B subsequently connected these components through an account coordinator, followed by Homebridge platform integration in Increment 6C.

### ✅ Increment 6B - Account Coordination and Lifecycle Management (Complete)

The second part of backend integration is now implemented.

A standalone account coordinator brings together the existing authentication, discovery, routing, MQTT lifecycle and device-state components. It manages account credentials, coordinates discovery and controls authorised MQTT connections without duplicating the responsibilities of the underlying components.

Account-context isolation protects against outdated discovery results, stale MQTT callbacks and credential changes. Previously authorised production connections can remain operational during temporary discovery failures, while confirmed account, routing and compatibility changes invalidate obsolete authority.

The coordinator also preserves cloud rate-limit cooldowns across context replacements and avoids unnecessary MQTT restarts when device routing remains unchanged.

Experimental Toniebox models are managed through separate connections and state adapters, isolated from production devices. A conservative limit of four experimental connections per account prevents uncontrolled resource consumption without arbitrarily selecting devices from an oversized set.

Privacy-safe diagnostics expose connection status, discovery health and conditions requiring attention without revealing account credentials, tokens or private device identifiers.

The coordinator remains independent of Homebridge. Increment 6B itself implemented neither HomeKit accessories nor device commands; the platform subsequently took responsibility for requesting startup discovery.

The project now passes **827 automated offline tests**, including **52 new tests** covering account coordination, credential transitions, discovery recovery, routing lifecycle management and experimental isolation. Validation also passed on Linux across the supported Node.js versions and minimum runtimes.

This completes Increment 6B. Increment 6C subsequently connected the standalone backend to Homebridge, including configuration, startup and shutdown handling.

### ✅ Increment 6C - Homebridge Platform Integration (Complete)

The final part of backend integration is now implemented.

The existing Toniebox account coordinator is now connected to the Homebridge platform lifecycle. The plugin can accept configured Tonies account credentials, initialise the backend after Homebridge finishes launching, and automatically begin device discovery and authorised MQTT connectivity.

Startup remains non-blocking, allowing Homebridge to operate normally while authentication and discovery take place. Missing or invalid credentials leave the backend safely inactive without attempting network communication.

A dedicated platform runtime manages discovery recovery using the coordinator's sanitised recovery advice. Temporary failures are retried using bounded backoff, jitter and existing cloud rate-limit protections. Successful discovery ends the recovery sequence without introducing continuous REST polling.

The integration also provides controlled shutdown, cancellation and protection against stale callbacks or asynchronous operations continuing after the backend has stopped.

Privacy-safe operational logging reports discovery progress, connection status and conditions requiring attention. Production and experimental connectivity are reported independently to avoid misrepresenting healthy connections.

Increment 6C left existing HomeKit accessory behaviour unchanged; it did not create accessories, expose HomeKit controls or publish device commands.

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

Commissioning diagnostics remain disabled in committed source. At the completion of Increment 7A, the plugin did not create HomeKit accessories or publish device commands.

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

This completes the presentation research stage, not production HomeKit integration. Increment 8B.1 subsequently established the backend-to-HomeKit contract, and Increment 8B.2 introduced the first read-only production accessory. The controls and additional services explored here remain planned functionality.

### ✅ Increment 8B.1 - Production HomeKit Integration Contract (Complete)

The first stage of production HomeKit integration is now complete.

The account coordinator now provides a read-only inventory of authorised production Tonieboxes and event-driven notifications for device, routing and connection-state changes.

The integration preserves existing account and MQTT session authority, distinguishes current from last-known routing information, and prevents stale or revoked connections from supplying authoritative updates. Experimental devices remain isolated from production HomeKit presentation.

Increment 8B.1 passed **1,181 automated offline tests**, including **31 new regression tests**. Validation also passed across the supported Node.js 22 and 24 runtimes.

Increment 8B.1 established the interface without publishing accessories or providing physical-device controls. Increment 8B.2 subsequently uses that contract for read-only SmartSpeaker presentation.

### ✅ Increment 8B.2 - External SmartSpeaker Lifecycle and Read-Only Presentation (Complete)

The first production HomeKit accessory is implemented: an externally published, read-only SmartSpeaker for authorised production Tonieboxes. Stable identities use verified account identity and normalised device MAC information, independently of display names. Experimental devices are excluded.

Playing, Paused and confirmed empty playback (Stopped) are presented through HomeKit. Usable current-session retained MQTT evidence, accompanied by connected-online evidence, can initialise and recover playback without another physical interaction. Live observations take precedence over delayed retained history within the same session, and stale sessions cannot restore authority. Retained snapshots remain cloud observations, not proof of liveness.

Physical offline or sustained uncertainty produces UNKNOWN/unavailable playback state rather than fabricated Paused state. A cancellable ten-second grace period preserves the last confirmed presentation during brief transport interruptions. Revocation, shutdown and late callbacks remain guarded; pairing identity is preserved for the same verified account and device. Writable commands, a Playback Switch, battery presentation, volume and other controls remain outside this increment.

**Automated validation:** For implementation commit `16919285f7fb82a2ae208d0fe8b07df3454a58af`, [Validate run #92](https://github.com/mitch7391/homebridge-toniebox/actions/runs/44049453142) passed **1,257 tests in each of four jobs**: Node.js 22.x and 24.x also passed build, typecheck and lint; minimum Node.js 22.10.0 and 24.0.0 passed compiled-output tests. No failures, cancellations, skips or TODOs were reported. Independent final review found no blocking correctness defects.

**Physical commissioning:** The maintainer successfully paired a real Toniebox 2 as an external SmartSpeaker in Apple Home using an isolated Raspberry Pi Homebridge instance. Playing recovered after restart in approximately four seconds; Paused recovered in approximately 2–4 seconds after playback changed while Homebridge was stopped. Live playback changes appeared within approximately two seconds, and figurine removal correctly displayed Stopped. Repeated isolated restarts preserved pairing, and production Homebridge remained unaffected.

Eleven approximately four-minute connection cycles were originally observed, each followed by connection establishment about two seconds later, without retry or attention-required notifications. A subsequent [MQTT logging refinement (PR #18)](https://github.com/mitch7391/homebridge-toniebox/pull/18) corrected the misclassification of healthy proactive credential replacements as connection interruptions. Physical commissioning on 18 November 2026 confirmed three consecutive successful credential replacements, each completing in approximately two seconds. Routine replacements now produce DEBUG diagnostics rather than misleading WARN and repeated INFO messages.

An additional startup observation remains under investigation: when powering on a previously offline Toniebox, physical playback began after approximately four seconds, while Apple Home reported Playing approximately 20–23 seconds after power-on. Restarting the Home app early did not shorten this delay. Once the Toniebox was online, playback changes continued to update within approximately two seconds. The cause of the startup reporting delay has not yet been established.

These are maintainer observations, not CI results or exhaustive physical offline/prolonged-outage testing. Apple Home's display of UNKNOWN may vary. [PR #17](https://github.com/mitch7391/homebridge-toniebox/pull/17) records the fuller commissioning evidence and limitations. General installation and release remain unavailable.

### ✅ Increment 8B.3A - Guarded MQTT Playback Publishing (Complete)

The first stage of production playback-control development is now implemented.

The existing MQTT v5 transport supports guarded publishing of the physically researched Play/Resume and Pause commands. It constructs fixed Toniebox playback-command topics and payloads internally, uses QoS 1 without retained publishing, and requires explicit route-level permission. Command publishing is disabled by default.

Publishing is limited to an established, ready connection and one outstanding operation per transport. A three-second acknowledgement deadline, cancellation, connection-closure handling and reentrancy protections prevent abandoned or outdated operations from remaining active.

MQTT v5 PUBACK handling correlates outgoing publications with their actual broker acknowledgements, including rejection and reason code 16 (No matching subscribers). A successful MQTT.js publish callback alone is not treated as sufficient acknowledgement. Results and diagnostics avoid exposing credentials, private device identifiers, topics or command payloads.

A broker acknowledgement does not prove that the Toniebox executed the requested action. Cancellation cannot retract an already transmitted command, and MQTT QoS 1 does not guarantee exactly-once physical execution. Broker-side delayed delivery and MQTT v5 message expiry remain considerations before physical command commissioning.

**Validation:** The final implementation passed **166 focused MQTT transport tests** and **1,335 automated offline tests** overall, together with ESLint, TypeScript typechecking and the production build. [GitHub Actions validation](https://github.com/mitch7391/homebridge-toniebox/actions/runs/45369353122) passed all four jobs across Node.js 22.x, 24.x and both minimum supported runtimes. The implementation also completed independent static review without identified blocking defects.

The changes are limited to the MQTT transport, its public types and transport regression tests. Existing receive-only subscriptions, authentication, connection lifecycle, account coordination and HomeKit behaviour remain unchanged.

This increment provides transport infrastructure only. No playback commands have been sent to the physical Toniebox using this implementation. Increment 8B.3B will introduce authorised command coordination and fresh physical-state confirmation, followed by writable HomeKit controls in Increment 8B.3C.

### ✅ Increment 8B.3B - Authorised Playback Command Coordination and Physical-State Confirmation (Complete)

The second stage of production playback-control development is now implemented.

The guarded MQTT publishing transport is connected to the MQTT lifecycle and account coordinator through a trusted internal `enablePlaybackCommands: true` opt-in. Normal Homebridge construction does not enable this option, so production operation remains read-only.

The coordinator authorises Play/Pause requests using exact account UUID, route ID and MAC address identity. Commands require current production Toniebox 2 routing authority, a ready MQTT session, connected-online evidence and usable playback state. Experimental devices, last-known routing authority, unsupported models and unknown, empty or inactive playback states cannot authorise commands.

An already-satisfied request can complete without publishing when authoritative current-session live playback state matches the requested action. Otherwise, confirmation requires both a positive MQTT broker acknowledgement and fresh, accepted, non-retained playback-state evidence showing the requested Playing or Paused state. Retained, duplicate, rejected, stale-session and unrelated observations cannot confirm execution. Matching evidence received before PUBACK can be held provisionally, but evidence from before dispatch is not accepted.

A single five-second overall deadline covers publishing and physical-state confirmation, while the transport retains its three-second PUBACK deadline. Only one command per device may remain pending, with no queuing, automatic retry or replay. Requests are cancelled when account, routing or session authority is lost, including credential replacement and shutdown. Failures distinguish commands definitely not dispatched from those with uncertain physical outcomes.

**Validation:** The implementation passed **199 focused MQTT lifecycle tests**, **194 focused account coordinator tests** and **1,394 automated offline tests** overall. ESLint, TypeScript typechecking and the production build passed. [GitHub Actions validation](https://github.com/mitch7391/homebridge-toniebox/actions/runs/45609290976) passed all four jobs across Node.js 22.x, 24.x and both minimum supported runtimes. Independent static review found no blocking correctness defects.

Changes are limited to lifecycle and coordinator implementation, their interfaces and regression tests. The MQTT transport, HomeKit presentation, configuration and dependencies remain unchanged. No physical playback commands were commissioned. Broker-side delayed delivery and MQTT v5 message expiry remain open considerations before live command testing.

Increment 8B.3C will introduce writable HomeKit playback actions and a dedicated Playback Switch using this authorised command path.

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
  - [x] **8B.2:** External SmartSpeaker lifecycle and read-only presentation
  - [ ] **8B.3:** Authorised playback control and HomeKit integration
    - [x] **8B.3A:** Guarded MQTT playback publishing transport
    - [x] **8B.3B:** Authorised command coordination and physical-state confirmation
    - [x] **8B.3B follow-up:** MQTT v5 playback message expiry safeguard
    - [ ] **8B.3C:** Writable SmartSpeaker playback actions and Playback Switch
- [ ] **Future:** Beta testing and refinement

Increment 8B remains incomplete. Guarded playback publishing and authorised command coordination with physical-state confirmation are implemented, but remain disabled in normal Homebridge construction and are not exposed as writable HomeKit controls. Remaining work includes writable HomeKit playback actions, a dedicated Playback Switch, battery telemetry, volume functionality, investigation of startup playback-state reporting latency, plugin settings and configuration UI improvements. The roadmap is subject to change as development progresses.

## How Will It Work?

One of the most exciting discoveries during the initial research was that Toniebox 2 can communicate through MQTT, rather than requiring constant requests to check what the device is doing.

That gives us the opportunity to build something much more responsive and efficient.

The broader planned integration combines the following. Although guarded MQTT playback publishing and authorised command coordination now exist, they remain disabled by default and are not connected to operational HomeKit controls. Settings writes are also not yet implemented:

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

The backend and read-only SmartSpeaker have been physically commissioned with a real Toniebox 2 in an isolated Raspberry Pi environment using Homebridge 2.4.0 and HAP-NodeJS 2.2.2. General installation compatibility, broader HomeKit functionality and long-term unattended reliability remain under development. This does not expand the declared compatibility ranges or establish physical validation across every supported Homebridge version.

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

Separate manual commissioning validated the backend against a real Toniebox 2 and Tonies Cloud in Increment 7A, followed by read-only SmartSpeaker presentation in Increment 8B.2. These results should not be confused with the automated GitHub Actions tests.

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
