# Discovery API evidence and Increment 4A policy

## Provenance and limits

The maintainer recovered the request construction and response observations below
from the original **10 October 2026** Toniebox 2 proof-of-concept conversation and
provided them with the Increment 4A implementation approval. This is a sanitised
record of that evidence, not a new live test or a universal Tonies API specification.

The broader findings and DO NOT RETEST requirements remain in
[the PoC handover](toniebox-poc-handover.md).

## Observed requests

The original Python helper constructed GET requests by concatenating
`https://api.prod.tcs.toys/v2` with each path, supplied
`Authorization: Bearer <access token>`, and parsed successful responses using
`json.load(response)`.

| Operation | Complete observed URL | Observed success shape |
| --- | --- | --- |
| Account | `https://api.prod.tcs.toys/v2/me` | JSON object |
| Households | `https://api.prod.tcs.toys/v2/households` | Top-level JSON array |
| Tonieboxes | `https://api.prod.tcs.toys/v2/households/{householdId}/tonieboxes` | Top-level JSON array |

The account code used `me.get("uuid") or me.get("id")`. This demonstrates a
fallback in that script, not identifier equivalence or an official precedence rule.

Household entries included `id`, `name` and `access`; the script used `id`.
Box entries included `id`, `householdId`, `macAddress`, `itemId`, `name`,
`features`, `generation`, `product`, and additional settings/state fields.
The tested device reported product `tb2` and generation `tng`. Its features
were an array of strings, including `ageMode`, `playbackControls` and
`bluetoothHeadphones`.

## Explicit implementation policy

These choices are defensive client policy, not additional experimental findings:

- Accept only the observed object/array shapes, never guessed collection envelopes.
- Treat an empty array as a structurally valid empty response. Actual empty-account
  behaviour was not observed. Rejected records remain visible through counts.
- Require nonblank string identities without control characters. Preserve their
  values, including case and surrounding spaces. Do not coerce numbers.
- Select a valid string `uuid`, otherwise a valid string `id`, for the account.
  Report the selected field as `identitySource`; do not equate different values.
- Reuse `DeviceIdentity`. Optional textual metadata is retained only when valid.
  Malformed optional fields are omitted and counted once per accepted record.
  Missing metadata does not count as malformed.
- Preserve unfamiliar products, generations and feature strings. An invalid feature
  array is omitted wholesale, not filtered into an apparently complete capability
  set. Missing features and an explicitly empty array remain distinct.
- Recognise identity without a MAC. For routing metadata, uppercase a valid
  topic-segment MAC without removing separators or asserting a hardware format.
- Within a box response, preserve different cloud identities sharing a normalised
  MAC and mark each returned affected device with `routingAmbiguous: true`.
  Consumers must not automatically route those devices. `ambiguousRoutingEntries`
  counts returned flagged devices, separately from duplicate-ID rejection counts.
  Otherwise valid records later rejected for duplicate IDs still contribute MAC
  conflict evidence; this conservatively protects surviving identities. Missing
  MACs are not conflicts. An absent flag is not proof of account-wide uniqueness;
  cross-household conflicts require additional checking during 4B aggregation.
- Retain optional box `householdId` and `itemId`. Reject a box whose valid,
  explicit household ID contradicts the requested household. Missing/malformed
  optional household metadata does not discard an otherwise identified box.
- Do not interpret household `access`: its representation and semantics were
  not characterised. Ignore other unknown fields, including REST `onlineState`.
- Reject every otherwise valid record in a duplicate ID group, whether identical
  or conflicting; preserve unrelated siblings. `duplicateEntries` is a subset
  of `rejectedEntries`. Degradation counts cover accepted records only.
- Diagnostics are counts and a continuation flag, without identifiers, field
  values or raw errors. Successful identities remain private runtime data.
- A detected HTTP Link relation `next`, HTTP 206, Content-Range, or an overlong Link header
  marks continuation/partial representation. No URL is followed. Absence of these
  signals does not prove that pagination is absent, nor that a catalogue is complete.
- GET requests use a fixed HTTPS origin, encoded household path segments, manual
  redirects, no cookies and no response caching. Reject empty/control-bearing IDs,
  exact dot segments, slash/backslash path IDs and unencodable strings.
- Bearer input must be nonempty printable ASCII without spaces, preventing unsafe
  header values; it is otherwise opaque and is never persisted.
- Bound each response to 1 MiB of streamed bytes and each request to 15 seconds
  by default, including body reading. Cancellation settles independently of a
  transport's willingness to abort. There is no background timer or polling.
- A rejected body-read operation is a sanitised `transport` failure. Invalid JSON,
  UTF-8, oversized bodies and invalid structures remain `invalid-response`.
  Already-settled cancellation or timeout takes precedence over a racing stream
  rejection; cleanup still releases the reader and request resources.
- Classify 401, 403 and 429 separately. Other non-success statuses remain HTTP
  failures. Do not parse error bodies, retry, refresh tokens or follow redirects.
- For 429/503, expose valid Retry-After delay-seconds or canonical IMF-fixdate as
  numeric milliseconds. Use an injectable wall clock for dates; expired dates
  yield zero. Invalid, unsupported or unsafe values are omitted, never guessed.
  Long valid delays are not shortened. This metadata does not schedule retries.

## Unknown contracts and later responsibilities

Still unknown: pagination conventions, observed empty-collection behaviour,
optionality and identity wire types across all generations, account identity
guarantees, identifier stability during transfers, and multi-household edge cases.

Account/household IDs are not assumed globally interchangeable. No Gen 1, Lite,
MQTT capability or live availability is inferred from the tested TB2.

Increment 4A does not own tokens, connect to Homebridge/MQTT, reconcile a persistent
catalogue, perform automatic rediscovery or orchestrate household traversal.
Increment 4B must consume diagnostics, preserve partial results, respect rate-limit
metadata, bound retries and cancellation, and avoid treating absence as deletion.
Future coordination owns cancellation and stale-result rejection when accounts
change; this stateless client cannot revoke access tokens already given to a request.

All new tests use synthetic values and fake transport/time. They validate client
policy, not additional physical or live cloud behaviour. Fetch/socket guards record
forbidden attempts independently of their thrown exceptions. Per-test and cumulative
suite audits assert zero attempts outside client exception handling, after draining
controlled late completions. Suite cleanup restores mocks even when an audit fails.