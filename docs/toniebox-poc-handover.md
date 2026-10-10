# homebridge-toniebox — Toniebox 2 PoC Technical Handover

**Date:** 10 October 2026  
**Status:** Toniebox 2 cloud integration feasibility substantially proven  
**Test device:** Toniebox 2 / TNG, product `tb2`, firmware `1.6.28`  
**Project:** `homebridge-toniebox`

## 1. Purpose

This document records the Toniebox 2 proof-of-concept work completed before implementation of `homebridge-toniebox`.

Its main purpose is to prevent Codex or future development work from repeating already-completed experiments.

Unless an implementation problem contradicts one of these results, treat items marked **VERIFIED** as established behaviour.

---

# 2. High-level conclusion

Toniebox 2 can support a strong Homebridge integration using a hybrid cloud architecture:

```text
REST / GraphQL
    ↓
Discovery, metadata, persistent settings

ICI MQTT v5 over secure WebSockets
    ↓
Live state + playback/device commands
```

The integration can be predominantly event-driven.

Toniebox 2 exposes:

- reliable live state
- retained MQTT state
- play/pause
- live volume and volume control
- current Tonie detection
- chapter state
- chapter selection
- current playback timing
- Tonie metadata and artwork
- chapter metadata
- battery/charging
- online/offline state
- headphones state
- sleep timer state/control
- writable box settings with application acknowledgement
- renewable authentication without repeatedly submitting the user's password

Routine high-frequency polling should **not** be necessary.

---

# 3. Test-device capabilities

The tested Toniebox returned:

```text
generation: tng
product: tb2
firmwareVersion: 1.6.28
```

Relevant advertised feature flags included:

```text
ageMode
tngSettings
automaticFreshnessCheck
language
iciSetupStatus
sleepTimerAlarm
bluetoothHeadphones
bluetoothHeadphoneSettings
playbackControls
```

Other observed box settings included:

```text
maxVolume
maxHeadphoneVolume
lightringBrightness
bedtimeLightringBrightness
bedtimeLightringColor
bedtimeMaxVolume
bedtimeMaxHeadphoneVolume
skippingEnabled
skippingDirection
scrubbingEnabled
offlineMode
```

REST returned:

```text
onlineState: unsupported
```

for this TNG/TB2 device.

**Important:** This does NOT mean the Toniebox is offline. Live online state for TB2 is available through ICI MQTT and was verified working.

---

# 4. Authentication

## 4.1 Initial login — VERIFIED

Authentication endpoint:

```text
POST
https://login.tonies.com/auth/realms/tonies/protocol/openid-connect/token
```

Form parameters:

```text
client_id=meine-tonies
grant_type=password
username=<Tonies account>
password=<Tonies password>
scope=openid
```

Authentication successfully returned:

- access token
- refresh token

Observed access-token lifetime:

```text
300 seconds
```

Therefore access tokens expire after approximately **5 minutes**.

Observed refresh-token lifetime:

```text
15,552,000 seconds
```

Approximately **180 days**.

---

# 5. Refresh-token flow

## VERIFIED

Refresh request:

```text
client_id=meine-tonies
grant_type=refresh_token
refresh_token=<current refresh token>
```

Observed result:

```text
Access token changed: True
New refresh token supplied: True
Refresh token rotated: True
```

Measured refresh request:

```text
~878.5 ms
```

The newly issued access token successfully authenticated against `/me`.

The refreshed token authenticated as the same Tonies account.

### Implementation requirement

Every successful refresh must replace the previously stored refresh token with the **newly rotated refresh token**.

Do not assume the original refresh token remains the canonical one.

Suggested flow:

```text
Initial username/password authentication
             ↓
Access token + refresh token
             ↓
Persist current refresh token securely
             ↓
Refresh before access token expires
             ↓
Replace BOTH tokens
             ↓
Reconnect/re-authenticate MQTT when necessary
```

The current HA-Toniebox implementation uses a roughly 60-second-before-expiry refresh buffer. That is a reasonable starting strategy.

---

# 6. Refreshed-token MQTT authentication

## VERIFIED

A newly obtained access token created solely through the refresh-token flow successfully:

1. authenticated REST requests,
2. discovered the Toniebox,
3. authenticated a completely new ICI MQTT connection.

Observed:

```text
MQTT result: Success
Live Toniebox state:
{"onlineState":"connected"}
```

Therefore the plugin does **not** need to perform username/password authentication whenever MQTT credentials expire.

Refresh-token renewal is sufficient.

---

# 7. ICI MQTT transport

Host:

```text
ici.tonie.cloud
```

Port:

```text
443
```

Transport:

```text
MQTT v5 over secure WebSockets
```

WebSocket path:

```text
/
```

MQTT credentials:

```text
username = Tonies user UUID
password = current access token
```

Commands and state were successfully exchanged using QoS 1.

---

# 8. MQTT topic structure

Per-box topic prefix:

```text
external/toniebox/{MAC}/
```

The implementation should internally normalise the MAC to uppercase.

Verified state topics:

```text
metrics/battery
online-state
metrics/headphones
settings-applied
playback/state
volume/state
app-reply/bedtime-state
```

Verified command root:

```text
app-control/{command}
```

Verified commands include:

```text
app-control/playback
app-control/volume
app-control/stl
```

A `sleep` command also exists in the current HA implementation but was deliberately NOT tested.

---

# 9. Retained MQTT state

## VERIFIED

The following topics immediately supplied retained QoS-1 state after a completely new subscription:

| Topic | Retained | QoS |
|---|---:|---:|
| Battery | Yes | 1 |
| Online state | Yes | 1 |
| Headphones | Yes | 1 |
| Playback | Yes | 1 |
| Volume | Yes | 1 |
| Bedtime/sleep timer | Yes | 1 |

`settings-applied` did not produce an initial retained value during this test.

This appears correct because it behaves like a transient settings transaction/status event rather than ordinary device state.

### Architecture consequence

A Homebridge restart can reconstruct most live state immediately from MQTT without waiting for another physical Toniebox event.

However, retained playback must be interpreted alongside retained online state.

Example:

```text
online = connected
paused = false
→ Playing

online = connected
paused = true
→ Paused

online = offline
→ Box unavailable/offline
```

Do NOT blindly report stale retained playback as currently active if the retained online state says the Toniebox is offline.

---

# 10. Event-driven behaviour

## VERIFIED

A passive 60-second MQTT observation produced an immediate state snapshot for:

```text
battery
online
headphones
playback
volume
bedtime
```

There were no periodic volume, online, headphone or bedtime updates during the minute.

Playback produced a second event only because the box changed chapter during the observation.

Therefore playback does **not** appear to emit a fixed periodic position update.

This is good.

Playback messages include sufficient information to calculate current position locally.

Routine playback polling is unnecessary.

---

# 11. Battery state

## VERIFIED

Example live payload:

```json
{
  "percent": 64,
  "raw": 68,
  "current": -0.265,
  "status": "discharging"
}
```

Other observed status:

```text
charging
```

Battery updates were observed during earlier testing.

The `current` field is also available, although whether it should be surfaced through HomeKit is undecided.

---

# 12. Online state

## VERIFIED

MQTT payload:

```json
{
  "onlineState": "connected"
}
```

Use this as the authoritative live connectivity state for TNG/TB2.

Do not rely on REST `onlineState`, which returned `unsupported`.

Natural offline/sleep lifecycle behaviour remains to be characterised.

---

# 13. Headphone/output state

## VERIFIED for passive state

Observed with no headphones attached:

```json
{
  "speaker": {
    "output": true
  },
  "connected": []
}
```

This proves live audio-output/headphone state is available.

Bluetooth headphone connection details have not yet been tested with actual headphones connected.

---

# 14. Live playback state

## VERIFIED

Example fields seen in `playback/state`:

```text
tonie
paused
blocked
downloading
ended
contentVersion
chapter
chapterUntilMs
chapterDuration
```

When paused, the payload additionally supplied:

```text
chapterPositionMs
```

Removing the physical Tonie produced:

```json
{
  "tonie": null
}
```

Replacing it restored full playback information.

Chapter numbers are zero-based.

---

# 15. Playback-position calculation

## VERIFIED

While playing, the box does not need to continuously publish progress.

Use:

```text
chapterDuration
chapterUntilMs
```

to calculate position locally.

Conceptually:

```text
remaining =
    chapterUntilMs / 1000
    - currentEpochSeconds

position =
    chapterDuration
    - remaining
```

Clamp the result between zero and chapter duration.

When paused, use exact:

```text
chapterPositionMs
```

This makes a locally advancing playback timer practical without polling.

---

# 16. Play/pause control

Command topic:

```text
external/toniebox/{MAC}/app-control/playback
```

Pause:

```json
{
  "action": "pause"
}
```

Resume:

```json
{
  "action": "start"
}
```

## VERIFIED

A real Toniebox accepted both commands and independently reported the corresponding state over MQTT.

Initial command test:

```text
Resume:      1042.6 ms
Pause:       1041.3 ms
Resume:      1118.1 ms
Volume up:   1011.3 ms
Volume down: 1088.7 ms
```

Average of this set:

```text
~1060 ms
```

A larger pause/resume test produced Toniebox confirmation times from:

```text
952.6 ms
to
1242.3 ms
```

Average:

```text
~1071 ms
```

This is command publish → independently observed resulting physical state.

---

# 17. MQTT PUBACK versus physical-state acknowledgement

## VERIFIED

QoS-1 broker PUBACK times were extraordinarily consistent:

```text
343.5–345.1 ms
```

approximately:

```text
~344 ms
```

Full Toniebox state confirmation still averaged approximately:

```text
~1.07 seconds
```

Therefore the majority of command latency occurs after broker acceptance, during downstream processing / device execution / state return.

### HomeKit implication

Use optimistic UI state for user-issued controls, then reconcile against authoritative MQTT feedback.

Example:

```text
User presses Pause
      ↓
Immediately update HomeKit state optimistically
      ↓
Publish MQTT pause
      ↓
~1 s later
MQTT confirms actual paused state
      ↓
Keep or correct HomeKit state
```

---

# 18. Volume state/control

## VERIFIED

Live volume payload:

```json
{
  "level": 9,
  "hardwarePercentage": 70
}
```

Observed mapping on the tested box included:

```text
level 8  → 60%
level 9  → 70%
level 10 → 80%
level 11 → 90%
level 12 → 100%
```

Earlier observed data also indicated lower discrete steps.

Command:

```text
app-control/volume
```

Payload:

```json
{
  "level": N
}
```

Volume changes were fast and reliably acknowledged through `volume/state`.

### Open question

The HA implementation currently allows a maximum discrete level of 13, but the tested Toniebox reached 100% at level 12.

Do not assume level 13 is meaningful without further investigation.

---

# 19. Chapter control

## VERIFIED

Chapter selection uses playback `setPosition`.

Example:

```json
{
  "action": "setPosition",
  "chapter": 8,
  "ms": 0
}
```

Chapter indexes are zero-based.

Real test:

```text
Current human chapter: 8

Forward:
chapter 8 → chapter 9
confirmed in 1378.4 ms

Return:
chapter 9 → chapter 8
confirmed in 1020.2 ms
```

Therefore these capabilities are confirmed:

```text
Previous chapter
Next chapter
Direct chapter selection
Restart selected chapter
```

---

# 20. In-chapter seeking

## IMPORTANT — VERIFIED NOT SUPPORTED IN PRACTICE

The command schema accepts:

```text
ms
```

and the HA client currently passes an `ms` parameter.

However, real Toniebox testing proved that arbitrary intra-chapter seeking does not work.

A controlled A/B/C test requested:

```text
0 seconds
60 seconds
120 seconds
```

within the same chapter.

After ~2 seconds of playback, reported positions were:

```text
Requested   0.0 s → 2.901 s
Requested  60.0 s → 3.029 s
Requested 120.0 s → 2.901 s
```

Conclusion:

```text
The `ms` value is ignored by the tested TB2.
```

`setPosition` effectively means:

```text
Select this chapter and start it from the beginning.
```

Do NOT implement arbitrary seeking based on the existence of the `ms` argument.

Do NOT retest this unless Tonies firmware/API behaviour changes.

---

# 21. Tonie metadata resolution

## VERIFIED

The opaque Tonie identifier from MQTT can be resolved to human-readable metadata.

GraphQL successfully returned:

```text
Title
Series
Language
Sales ID
Artwork
```

Example test content resolved correctly to its commercial Tonie name and artwork.

GraphQL returned an empty chapter array for the tested commercial Content Tonie, so GraphQL alone is not sufficient for active playback chapter metadata.

---

# 22. `/playback-info` endpoint

Endpoint:

```text
GET /v2/playback-info/{toniebox_id}/{tonie_id}
```

Initial request failed:

```text
HTTP 400
```

Error body:

```json
{
  "errors": [
    {
      "code": "missing",
      "key": "contentVersion"
    }
  ]
}
```

This revealed an undocumented/current API requirement.

The request must include the current MQTT playback `contentVersion`:

```text
?contentVersion=<current value>
```

Example:

```text
/playback-info/{box}/{tonie}?contentVersion=1759218085
```

## VERIFIED

With `contentVersion`, response returned:

```text
status: available
tonieType: content
series
title
tonieImageUrl
coverUrl
chapters
```

For the tested Content Tonie it returned **18 chapters**, each with chapter title and duration.

This is the correct source for current loaded chapter metadata.

---

# 23. Metadata architecture

Recommended flow:

```text
MQTT playback/state
        ↓
Tonie ID + contentVersion
        ↓
If either changed:
    call playback-info once
        ↓
cache:
    title
    series
    artwork
    cover
    chapter list
    durations
```

If Tonie ID and `contentVersion` are unchanged, do NOT repeatedly call REST when only chapter position/state changes.

This avoids unnecessary API traffic.

---

# 24. Sleep timer

State topic:

```text
app-reply/bedtime-state
```

Command:

```text
app-control/stl
```

Enable:

```json
{
  "state": "on",
  "duration": 3600
}
```

Cancel:

```json
{
  "state": "off"
}
```

## VERIFIED

Off state example:

```json
{
  "stl": {
    "state": "off",
    "defaultDuration": 3600
  }
}
```

On state:

```json
{
  "stl": {
    "state": "on",
    "duration": 3600,
    "defaultDuration": 3600,
    "until": 1791608800
  }
}
```

`until` is a Unix epoch timestamp.

Therefore the plugin can calculate remaining sleep time locally without polling.

---

# 25. Sleep-timer timings

Six set/cancel operations were measured.

Range:

```text
1338.6 ms – 1443.2 ms
```

Average:

```text
~1404 ms
```

Sleep timer control is therefore slightly slower than playback control but highly consistent.

---

# 26. Sleep-timer default behaviour

## VERIFIED

Before one test, the box reported an existing timer:

```text
duration: 1800
defaultDuration: 1800
```

After sending a 3600-second timer:

```text
duration: 3600
defaultDuration: 3600
```

After cancellation:

```text
state: off
defaultDuration: 3600
```

Conclusion:

`defaultDuration` appears to represent the remembered/last-selected timer duration rather than a fixed factory setting.

### Important current test-side effect

The PoC changed the remembered sleep-timer default from **30 minutes to 60 minutes**.

At the end of testing the retained bedtime state reported:

```text
defaultDuration: 3600
```

If the user's desired default is still 30 minutes, restore this later.

---

# 27. Immediate sleep command

Current HA code suggests:

```text
app-control/stl
{"state":"on","duration":300}
```

followed by:

```text
app-control/sleep
{}
```

for immediate sleep.

## NOT TESTED

This was deliberately avoided because immediate sleep makes the box go offline and cloud control apparently cannot remotely wake it again.

Do not test casually.

---

# 28. Writable Toniebox settings

Persistent settings are changed using REST:

```text
PATCH
/households/{household}/tonieboxes/{box}
```

This was verified with:

```text
lightringBrightness
skippingEnabled
scrubbingEnabled
```

All three used the same application lifecycle.

---

# 29. Settings application handshake

## VERIFIED

After a REST PATCH:

```text
~1.6–1.7 seconds
settings-applied:
{"settingsApplied": false}

~0.7 seconds later
settings-applied:
{"settingsApplied": true}
```

Total physical/application acknowledgement:

```text
approximately 2.3–2.4 seconds
```

### Brightness measurements

Change:

```text
false: +1603.9 ms
true:  +2304.8 ms
```

Restore:

```text
false: +1586.7 ms
true:  +2285.3 ms
```

### skippingEnabled

Change:

```text
false: +1628.6 ms
true:  +2356.2 ms
```

Restore:

```text
false: +1717.4 ms
true:  +2386.3 ms
```

### scrubbingEnabled

Change:

```text
false: +1737.3 ms
true:  +2411.1 ms
```

Restore:

```text
false: +1572.1 ms
true:  +2283.1 ms
```

The values were also confirmed through REST after each change.

All tested settings were restored to their original values afterward.

---

# 30. Settings semantics

Interpret settings transaction as:

```text
PATCH submitted
      ↓
Cloud stores requested value
      ↓
settingsApplied:false
      ↓
Physical Toniebox still applying/synchronising
      ↓
settingsApplied:true
      ↓
Latest settings physically applied
```

Recommended implementation:

```text
optimistically update requested state
        ↓
mark update pending
        ↓
settingsApplied:false
        ↓
remain pending
        ↓
settingsApplied:true
        ↓
mark confirmed
```

If `true` is not received within a reasonable timeout, refresh through REST and reconcile.

---

# 31. HA-Toniebox issue discovered

The current inspected HA-Toniebox implementation handles the topic approximately as:

```python
elif subtopic == ICI_TOPIC_SETTINGS:
    tb["settings_applied"] = True
```

This is incorrect based on real-device testing.

The actual payload can explicitly be:

```json
{"settingsApplied": false}
```

or:

```json
{"settingsApplied": true}
```

`homebridge-toniebox` must preserve and interpret the boolean value.

Do not copy the current HA logic blindly.

Another likely stale behaviour is its `/playback-info` call, which did not include the newly required `contentVersion` in the inspected version.

---

# 32. Tested persistent settings

### `lightringBrightness`

Test:

```text
100% → 80% → 100%
```

REST changed correctly.

Full false/true application handshake observed.

No need to retest basic write functionality.

### `skippingEnabled`

Test:

```text
true → false → true
```

REST and MQTT application acknowledgement verified.

Physical tapping behaviour was not manually tested because the children were asleep.

### `scrubbingEnabled`

Test:

```text
true → false → true
```

REST and MQTT application acknowledgement verified.

Physical tilt behaviour was not manually tested.

---

# 33. Other potentially writable settings

Current API/integration code indicates support for:

```text
bedtimeLightringBrightness
bedtimeMaxVolume
bedtimeMaxHeadphoneVolume
maxVolume
maxHeadphoneVolume
skippingDirection
ageMode
language
```

Do not individually retest merely to prove the common REST PATCH mechanism.

Only test them later if their specific semantics matter for HomeKit/UI design.

`offlineMode` appears read-only through the REST API.

---

# 34. Homebridge state model

Recommended broad architecture:

```text
TonieCloudAuth
├── initial password authentication
├── refresh-token rotation
└── access-token lifecycle

TonieCloudREST
├── account/household discovery
├── box discovery/capabilities
├── metadata
├── playback-info
└── persistent settings writes

TonieICIClient
├── persistent MQTT v5/WSS
├── retained live state
├── live commands
├── reconnect/backoff
└── token-change reconnect

TonieboxState
├── connectivity
├── battery
├── playback
├── volume
├── current Tonie
├── chapter metadata
├── headphones
├── sleep timer
└── settings transaction status
```

Do not tightly couple Tonie Cloud protocol logic directly into HomeKit accessory classes.

Keep protocol/state handling independent so HomeKit mapping can evolve.

---

# 35. Polling strategy

Toniebox 2 should be primarily event driven.

Avoid a legacy-style 30/60/90-second live-state polling loop.

Use MQTT for:

```text
online
battery
headphones
playback
volume
sleep timer
settings acknowledgement
```

Use REST only for:

```text
startup discovery
metadata enrichment
persistent configuration
occasional reconciliation
authentication
```

Local timers can extrapolate playback position and sleep-timer remaining time.

---

# 36. Multi-box design

Likely architecture:

```text
one Tonies account
       ↓
one authenticated account/client context
       ↓
one persistent ICI MQTT connection
       ↓
multiple box MAC topic namespaces
```

Do not create a separate authentication stack per Toniebox unless a future API limitation requires it.

Multi-box operation itself has not yet been physically tested because only one box is available in the test account.

---

# 37. Privacy/logging requirements

Never log raw:

```text
access tokens
refresh tokens
passwords
account email
user UUID
household UUID
box UUID
MAC address
raw Tonie/content identifier
```

Tonie IDs should be redacted or hashed in normal logs.

Debug logs should still avoid tokens/passwords entirely.

Example:

```text
Current Tonie changed: tonie_7f23…
```

rather than exposing the full content ID.

The PoC scripts intentionally began redacting identifiers once their sensitivity became clear.

---

# 38. HomeKit mapping remains intentionally undecided

Do NOT automatically expose Toniebox as a Television merely to gain richer HomeKit controls.

The user explicitly prefers a semantically appropriate speaker/media mapping.

Backend capabilities should be implemented independently of Apple's current Home UI limitations.

This allows richer Home/HomeKit media capabilities to be adopted later without rewriting the Tonie Cloud integration.

Apple/Home accessory design should be revisited separately.

---

# 39. Capabilities now considered proven

```text
Account login                         VERIFIED
REST discovery                        VERIFIED
Refresh tokens                        VERIFIED
Refresh-token rotation                VERIFIED
5-minute access-token lifecycle       VERIFIED
Refreshed-token REST use              VERIFIED
Refreshed-token MQTT reconnect        VERIFIED

ICI MQTT v5/WSS                       VERIFIED
QoS 1                                 VERIFIED
Retained device state                 VERIFIED
Event-driven playback                 VERIFIED

Battery state                         VERIFIED
Charging/discharging state            VERIFIED
Online state                          VERIFIED
Speaker/headphone state               VERIFIED
Volume state                          VERIFIED
Volume control                        VERIFIED

Current Tonie detection               VERIFIED
Tonie removal/replacement             VERIFIED
Play                                   VERIFIED
Pause                                  VERIFIED
Current chapter                       VERIFIED
Next chapter                           VERIFIED
Previous chapter                       VERIFIED
Direct chapter selection              VERIFIED
Restart chapter                       VERIFIED
Playback duration                     VERIFIED
Playback position calculation         VERIFIED
Exact paused position                 VERIFIED

Arbitrary in-chapter seek             NOT SUPPORTED

Tonie title/series metadata            VERIFIED
Artwork                               VERIFIED
Cover artwork                         VERIFIED
Content type                          VERIFIED
Chapter names/list                    VERIFIED
Chapter durations                     VERIFIED
contentVersion metadata lookup        VERIFIED

Sleep timer state                     VERIFIED
Sleep timer set                       VERIFIED
Sleep timer change                    VERIFIED
Sleep timer cancel                    VERIFIED
Sleep timer absolute expiry           VERIFIED
Sleep timer remembered duration       VERIFIED

Persistent REST settings writes       VERIFIED
Settings false→true handshake         VERIFIED
Ring brightness                       VERIFIED
Skipping enabled                      VERIFIED
Scrubbing enabled                     VERIFIED
```

---

# 40. DO NOT RETEST

Unless implementation behaviour contradicts these findings, Codex should NOT spend time reproving:

```text
✓ Whether Toniebox 2 can be controlled through Tonie Cloud
✓ Whether ICI MQTT works
✓ MQTT host/port/WebSocket transport
✓ MQTT authentication format
✓ Whether MQTT state is retained
✓ Whether battery is available
✓ Whether online state is available
✓ Whether headphones state is available
✓ Whether live volume is available
✓ Whether volume can be controlled
✓ Whether play/pause works
✓ Approximate play/pause latency
✓ Whether Tonie insertion/removal is visible
✓ Whether current chapter is available
✓ Whether chapter changes generate events
✓ Whether next/previous chapter works
✓ Whether direct chapter selection works
✓ Whether `ms` enables arbitrary seek — it does NOT
✓ Whether playback position can be calculated
✓ Whether Tonie IDs can resolve to metadata
✓ Whether artwork can be retrieved
✓ Whether chapter metadata can be retrieved
✓ Whether playback-info requires contentVersion
✓ Whether sleep timer can be read/set/cancelled
✓ Whether sleep timer includes an absolute expiry
✓ Whether persistent box settings can be PATCHed
✓ Whether settingsApplied false/true is meaningful
✓ Whether refresh-token authentication works
✓ Whether refresh tokens rotate
✓ Whether refreshed access tokens work with MQTT
```

Reuse these results.

---

# 41. NOT YET TESTED

The following remain legitimate future experiments.

### Natural sleep/offline lifecycle

Still need to observe what happens when the Toniebox naturally sleeps:

```text
Does online-state become retained "offline"?
What happens to retained playback?
Does battery send a final null payload?
Which topics update when the box wakes?
In what order do wake events arrive?
What does a new subscriber receive while box is asleep?
```

This should preferably be observed naturally rather than forcing sleep while children are using the box.

### Immediate sleep

Known command path exists, but intentionally not tested.

### Bluetooth headphones

No physical Bluetooth headphones were connected during PoC.

Need eventually verify:

```text
connection event
headphone metadata
battery if available
audio-output switching
disconnect behaviour
```

### Multiple Tonieboxes

Architecture appears suitable, but only one physical TB2 has been tested.

### Generation 1 / Classic Toniebox

Not tested.

TNG ICI behaviour must NOT be assumed to apply to classic Tonieboxes.

Capability gating is required.

### Creative Tonies

Current playback/control fundamentals should apply, but Creative-specific metadata/content management has not been characterised.

### Content Discs

Not tested.

### Alarm / newer TB2-specific features

The device advertises `sleepTimerAlarm`, but alarm functionality has not yet been reverse engineered or tested.

### Error/reconnect behaviour

Still worth testing during implementation:

```text
network interruption
MQTT broker disconnect
expired MQTT access token
REST 401
invalid refresh token
box offline while command sent
command acknowledgement timeout
```

These should mostly be implementation tests rather than more manual PoC work.

---

# 42. Known PoC environment

Temporary Python environment used:

```text
/tmp/tonie-poc
```

Installed dependency:

```text
paho-mqtt >=2,<3
```

Credentials were temporarily provided through:

```bash
read -rp "Tonies email: " TONIE_USER
read -rsp "Tonies password: " TONIE_PASS; echo
export TONIE_USER TONIE_PASS
```

Cleanup:

```bash
unset TONIE_USER TONIE_PASS
```

Do NOT embed credentials in source code.

---

# 43. Recommended implementation priorities

1. Build authentication client with refresh-token rotation.
2. Build REST discovery client.
3. Build persistent ICI MQTT client with reconnect/backoff.
4. Build account/box capability model.
5. Build retained-state cache.
6. Implement live playback/volume/battery/online/headphone/sleep state.
7. Implement play/pause/volume/chapter commands.
8. Implement metadata cache using Tonie ID + `contentVersion`.
9. Implement sleep-timer control.
10. Implement persistent settings transaction model.
11. Add privacy-safe structured logging.
12. Only then finalise HomeKit accessory mapping.

---

# 44. Core architectural principle

The most important result of the PoC is that Toniebox 2 does **not** need to be treated like a periodically polled web API.

It behaves much more like an event-driven connected device.

The plugin should therefore be designed around:

```text
REST for configuration/discovery
+
MQTT for live runtime state
+
local cache/state machine
```

rather than:

```text
poll REST every N seconds
```

That architectural decision should be preserved.

---

# 45. Current project status

The backend feasibility of `homebridge-toniebox` for Toniebox 2 is now substantially proven.

The remaining uncertainty is primarily:

```text
HomeKit accessory/UI mapping
Classic/Gen 1 capability coverage
natural sleep/wake lifecycle
some advanced TB2 features
production-quality reconnect/error handling
```

There is no need for another general feasibility phase before implementation.

Codex should treat this document as the baseline evidence from the real Toniebox 2 PoC.
