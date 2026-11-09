# Increment 8A findings and presentation decision

Research close-out: 9 November 2026. Scope: synthetic Scenarios A-I only.
This records the maintainer's reported client observations, the fixture's offline
evidence and the agreed presentation direction. It does not implement production
accessories, establish real Toniebox command support or authorise deployment.

## Evidence and limits

- **Manual / Apple Home and Siri:** observations reported by the maintainer after
  testing on an iPhone. They were not independently repeated during close-out.
- **Manual / Eve:** separately reported third-party client observations.
- **Reported synthetic logs:** the maintainer reports successful fixture writes;
  no raw log capture is reproduced or independently audited here.
- **Offline:** tests exercise installed HAP classes and Homebridge API seams
  without publishing a server, pairing or contacting Tonies Cloud.
- **Unknown:** a result not supplied must not be inferred from a characteristic's
  existence, a scene editor option or success in another client.

The reports do not provide a complete per-scenario/version observation record for
D-H. Shared SmartSpeaker findings below are therefore not asserted as individual
successful trials of every D-H configuration. Exact iOS, Eve and home-hub versions,
and the manual test dates, were not supplied with the close-out summary.

The recorded offline environment is Windows Node.js 24.19.0, Homebridge 2.4.0 and
HAP 2.2.2. The completed fixture has 122 passing offline tests. That is not evidence
of Linux, Node.js 22 or older Homebridge execution, certification, or universal
Apple Home presentation. A supported API does not override a host release's Node
engine requirements.

## Scenario inventory and evidence

All scenarios include AccessoryInformation and synthetic Battery data. Except B/C,
accessories are externally published. The default battery is 64%, discharging.

| Scenario | Fixture arrangement verified offline | Manual evidence and remaining limits |
| --- | --- | --- |
| A | External primary SmartSpeaker, unlinked Battery; playback writes reject. | Apple Home: paired under Speakers & TVs with speaker icon and Paused state. Controls not available; media/volume greyed out. Battery fields absent in inspected screens. |
| B | Bridged primary SmartSpeaker and Battery; playback writes reject. | Apple Home: Other, generic house icon, Not Supported tile. Paused and battery 64% / Charging No visible in details. |
| C | Bridged primary Battery, category Other; no playback controls. | Apple Home: paired, Other / Not Supported; battery 64% / Charging No visible. No useful primary controls. |
| D | External SmartSpeaker with explicitly linked Battery; playback writes reject. | Link-only comparison. No isolated D-specific improvement in Apple Home battery visibility was supplied. See shared Eve finding below. |
| E | D plus functioning synthetic TargetMediaState Play/Pause. | Shared SmartSpeaker reports establish scene-based playback writes, not enabled direct native media controls. No separate E-only client/version record was supplied. |
| F | D plus Playback Switch; native TargetMediaState writes still reject. | Shared reports establish useful direct Home/Siri switch control. Do not attribute native media writes to F's intentionally rejecting handler. |
| G | Linked Battery, SmartSpeaker and Playback Switch sharing one playback state; both playback inputs work. | Consistent with the reported combined native scene and direct switch approach. Per-client results are recorded below without inventing a G-only test log. |
| H | G plus native SmartSpeaker Volume and synthetic independent Mute. | SmartSpeaker volume scene writes reported; Eve offers no interactive SmartSpeaker volume slider. H's synthetic mute is not a production capability. |
| I | External regular Speaker, linked Battery and Playback Switch; writable Volume; mandatory Mute writes reject. No native media-state or Active characteristic. | Apple Home lacks a useful speaker tile/direct volume; volume unavailable in tested scenes/automations; direct Siri volume failed. Eve recognises Speaker and has a working volume slider; repeated writes confirmed by reported synthetic logs. |

## Client findings

### External SmartSpeaker

**Manual / Apple Home:** externally publishing SmartSpeaker gives the intended
speaker identity under Speakers & TVs and displays Playing/Paused. Direct native
media controls remain unavailable. Appropriate Home scenes can issue native
playback writes. The dedicated Playback Switch supplies working direct Home and
Siri control. Native SmartSpeaker Volume accepts scene-based volume commands.

**Manual / Eve:** battery telemetry is accessible, including with the linked
Battery arrangement, even where Apple Home hides it. Eve did not provide an
interactive SmartSpeaker volume slider in the reported testing.

**Offline:** E/G/H accept Play/Pause at the native callback; F/G/H accept switch
writes, with G/H keeping both inputs and state characteristics synchronised.
H accepts native volume/mute writes in the simulation. This confirms the fixture
handler contracts, not that every client exposes or invokes them.

There is no demonstrated universal improvement in Apple Home battery visibility
from linking alone. Do not equate scene-editor options with command receipt.

### Regular Speaker (I)

**Manual / Apple Home:** no usable speaker tile or direct volume control. Native
volume was not selectable in tested scenes and automations.

**Manual / Siri:** direct volume commands did not work.

**Manual / Eve and reported synthetic logs:** Eve recognises the Speaker service,
provides a functional volume slider, and repeated successful volume writes were
reported in synthetic logs. Rapid slider movement can create bursts of writes.

**Offline / HAP contract:** regular Speaker requires Mute and optionally supports
Volume. The fixture publishes it correctly, rejects every mute operation, and
does not emulate mute with zero volume. It has no native playback state or
commands; playback is represented only by the independent Switch. The close-out
report does not establish I-specific battery visibility, switch layout or the
appearance of a mute button in every client.

### General conclusions

- A valid HAP characteristic is not necessarily exposed by Apple Home.
- Apple Home, Siri and Eve must be assessed separately.
- Linked Battery is useful to third-party clients without guaranteeing Apple
  Home visibility.
- A dedicated Switch is the most practical direct playback control demonstrated
  in Apple Home.
- UI animations and scene choices do not prove a HAP write happened. A received
  log alone is also weaker than an applied transition.
- Synthetic success means fixture state changed, never physical-device success.
- Bursty volume input is an implementation requirement for future real commands;
  the synthetic test does not establish cloud/device throughput or ordering.

## Agreed production presentation direction

This is a design decision for future architecture work, not implemented here.

| Default element | Purpose and boundary |
| --- | --- |
| Native SmartSpeaker | Speaker identity and genuine playback-state presentation; use the external presentation demonstrated by the research, subject to production lifecycle design. |
| Native playback characteristics | Supported HomeKit scene actions, mapped only to established real backend capabilities. |
| Dedicated Playback Switch | Direct Home/Siri control sharing the same confirmed playback state. |
| Native SmartSpeaker Volume | Scene-based volume actions sharing genuine confirmed volume state. |
| Linked Battery | Genuine telemetry, preserving unknown/unavailable values without fabricating 0%. |

There is no established independent Toniebox Mute command. Do not carry H's
synthetic mute behaviour into production or invent mute by changing volume.
SmartSpeaker Mute is optional and is not part of the agreed default services.
Production acknowledgement, freshness and failure semantics must be designed
against the actual backend before implementation; optimistic fixture transitions
are not a model of physical confirmation.

### Deferred optional Volume Slider

A separate HomeKit Lightbulb Brightness presentation may be considered later,
not in the first production integration. It must:

- Be explicit opt-in in the Homebridge plugin settings UI and disabled by default.
- Clearly explain that it appears as a light in Apple Home.
- Share confirmed volume state with the primary accessory.
- Avoid invented power or mute semantics, including ambiguous Lightbulb On writes.
- Handle rapid updates reliably with ordering, confirmation and failure behaviour
  appropriate to the real backend.
- Retain a stable accessory identity across enable/disable cycles; define its
  registration/removal lifecycle without assigning a new identity each time.

This alternative has not been implemented or tested by Scenarios A-I. Required
Lightbulb characteristic semantics remain a design question, not permission to
fake a power operation. It is an optional enhancement, not a mandatory workaround.

### Rejected or deferred alternatives

| Approach | Decision and reason |
| --- | --- |
| Regular Speaker as primary | Not selected: Eve volume works, but the reported Apple Home tile, direct volume, scenes and Siri results are weaker than SmartSpeaker. |
| Duplicate SmartSpeaker and Speaker solely for Eve | Not selected: extra service/control surfaces and synchronisation complexity for one client's slider; no demonstrated need justifies duplication. |
| Television presentation | Not pursued: unrelated device semantics and unnecessary complexity. No comparative Television result is claimed. |
| Mandatory third-party application | Rejected as a product requirement. Eve remains useful for inspection and battery access, not a required playback controller. |
| More synthetic presentation experiments | Deferred: current evidence is sufficient to choose the initial direction. Preserve the fixture rather than adding more service variants. |

## Offline preservation and safety evidence

The suite covers A-I service layout, linked Battery, deterministic isolated
identities/ports, guarded writes, shared playback state, independent volume/mute
where supported, unsupported mute rejection in I, unknown battery, cancellation,
shutdown, reentrancy, cache restoration and bounded diagnostics. Independent
guards audit forbidden network/polling attempts and unhandled rejections.

G/H/I use public synchronous HAP setter callbacks so the guard covers HAP's cache
update and notification, avoiding stale asynchronous cross-control completion.
The tests exercise that ordering using the installed library. Future dependency
upgrades must preserve the contract or reveal the change in regression tests.

Public synthetic fixture PINs and identities are deliberately retained in sample
configs and launch instructions. They are not production pairing credentials.
Do not commit real pairing records, Homebridge persist/accessories storage,
credentials, tokens, logs, dependencies, generated output or ZIP archives.

## Close-out and next gate

Preserve the isolated fixture, tests, sample configs and research documentation
for independent maintainer review. The [README](README.md) retains safe manual
launch/restart/removal procedures; this close-out authorises none of those actions.

The next planned activity is **Increment 8B - Production HomeKit Architecture
Discovery**: inspect existing discovery, account-coordinator, MQTT, device-state
and commissioning contracts before selecting implementation boundaries.
That investigation and all production implementation remain outside this task.
