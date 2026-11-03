# event-quality-gate

A CI gate for two things that often break a growth experiment: events that are instrumented wrongly, and a readout computed the wrong way. It is a TypeScript library and a command-line tool, `eqg`, with one plan file that all three checks share.

Everything here runs on synthetic data and on the sample code in this repository. It has not seen production traffic, and nothing in it describes how any company's analytics or experiment systems work.

## What it checks

| command | input | what it decides |
| --- | --- | --- |
| `eqg lint-code` | TypeScript or JavaScript source | whether each call to a tracker matches the tracking plan |
| `eqg check-stream` | a JSONL file of events (or standard input) | whether the events conform to the plan and arrive in a sane order and time |
| `eqg readout` | a JSONL file of experiment rows | whether the assignment split is intact, and what the ratio-metric intervals are when users, not requests, are the unit |
| `eqg validate-plan` | a plan file | whether the plan itself is well-formed |

Every command exits 0 when it has no findings, 1 when it has findings, and 2 when it could not run (a bad flag, unreadable input, or an invalid plan handed to a command that needs one; `validate-plan` itself exits 1 for an invalid plan). A run that checked nothing is not a pass: an empty stream, an empty experiment file and a scan that finds no tracker call all exit 1.

**`lint-code`** reads source with the TypeScript compiler API and looks at calls to `track(name, props)` and `analytics.track(name, props)` (change them with `--tracker`, repeatable, such as `--tracker this.analytics.track`). It compares only what is written as a literal: the event name, the property keys, and the type of literal values. It reports an unknown event, a missing required property, an unexpected property, a literal of the wrong type, a literal outside an enum, and an email or phone shaped literal in a property the plan does not mark `pii`. Whatever it cannot read it reports as unverifiable and counts against the run: an event name that is not a string literal, properties passed as a variable, or an object literal with a spread or a computed key. `--allow-unverifiable` keeps them in the output but lets the run pass. Findings are printed as `file:line:column`, or as JSON with `--format json`.

**`check-stream`** reads one JSON object per line. It reports lines that are not JSON or lack a well-formed envelope, unknown events, missing required properties, unexpected properties, type and enum mismatches, repeated event ids, users who reach a later funnel step before an earlier one, late events and clock skew against a stated tolerance, properties with more distinct values than the plan allows, and email or phone shaped values in properties not marked `pii`. It prints the count of each finding type and a few examples of each, and never stores more than the examples, so memory grows with the number of event ids and users, not with the number of findings.

**`readout`** reads one row per request (`user_id`, `arm`, `y`, optional `x`). It tests the number of users per arm against the planned split with a chi-square test (sample ratio mismatch), and computes the interval for the ratio metric R = mean(y) / mean(x) two ways from the same rows: with the user as the unit (the delta method below), and with every request as the unit, as if requests were independent. The second is printed to show the size of the error, not as an option. With `--covariates` it also runs CUPED on the per-user total of `y`.

## Quick start

Needs Node 20 or later.

```sh
git clone https://github.com/muhammad-musa-ml/event-quality-gate
cd event-quality-gate
npm ci
npm run build
node dist/src/cli.js lint-code examples/code/clean --plan examples/tracking-plan.json
node dist/src/cli.js lint-code examples/code/faulty --plan examples/tracking-plan.json
```

The first run exits 0:

```
eqg lint-code: scanned 3 files, 9 calls to track or analytics.track (9 with a literal event name); 10 property values not compared because they are not literals
PASS: no findings
```

The second exits 1. The faulty sample has one planted fault per finding type, each named in a comment above it:

```
examples/code/faulty/onboarding.ts:7:3: unknown-event: event "signup_complete" is not in the plan
examples/code/faulty/onboarding.ts:12:3: missing-required-property: "workspace_created" is missing required property "plan_tier"
examples/code/faulty/onboarding.ts:17:73: unexpected-property: property "colour" is not declared for "page_created"
...
findings: 8 (enum-violation 1, missing-required-property 1, non-literal-event-name 1, pii-shaped-value 1, type-mismatch 1, unexpected-property 1, unknown-event 1, unverifiable-properties 1)
FAIL
```

The same pair for events and for an experiment:

```sh
node dist/src/cli.js check-stream examples/streams/clean.jsonl --plan examples/tracking-plan.json     # exit 0
node dist/src/cli.js check-stream examples/streams/faulty.jsonl --plan examples/tracking-plan.json    # exit 1
node dist/src/cli.js readout examples/experiment/clean.jsonl --split control=1,treatment=1 \
  --covariates examples/experiment/pre-period.jsonl                                                   # exit 0
node dist/src/cli.js readout examples/experiment/srm.jsonl --split control=1,treatment=1              # exit 1
```

The last command ends with:

```
sample ratio: control 240 (expected 200.0), treatment 160 (expected 200.0); chi-square 16.000, df 1, p 6.33e-5, alpha 0.001: MISMATCH
...
sample-ratio-mismatch: users per arm are control 240, treatment 160 against a planned 1:1 split (expected 200.0, 200.0); chi-square 16.00 on 1 df, p = 6.33e-5 is below 0.001
FAIL: 1 finding
```

The clean experiment shows what the user-level interval is for. Both arms of `examples/experiment/clean.jsonl` have the same true success rate, so the true difference is zero. The request-level interval for the difference excludes zero and the user-level one does not:

```
treatment minus control:
  by user:    0.04540 [-0.01089, 0.10169], includes zero
  by request: 0.04540 [0.00882, 0.08198], excludes zero
  the user-level interval is 1.54 times as wide as the request-level one
```

That file is generated from seed 1, the first seed (counting up from 1) that produced the disagreement; `scripts/make-examples.ts --search-seed` shows the search. The coverage table below shows how often each kind of interval misses the true value when requests are correlated within users.

## The tracking plan

One JSON file; the schema is [`schema/tracking-plan.schema.json`](schema/tracking-plan.schema.json) and a worked plan is [`examples/tracking-plan.json`](examples/tracking-plan.json).

```json
{
  "version": 1,
  "events": {
    "workspace_created": {
      "properties": {
        "workspace_id": { "type": "string" },
        "plan_tier": { "type": "string", "enum": ["free", "plus", "business"] },
        "seats": { "type": "integer" },
        "contact_email": { "type": "string", "pii": true },
        "referrer": { "type": "string", "maxDistinct": 40 }
      },
      "required": ["workspace_id", "plan_tier"]
    }
  },
  "funnel": ["signup_completed", "workspace_created", "page_created"]
}
```

- Property types are `string`, `number`, `integer` and `boolean`. `enum` lists the only allowed values.
- `pii: true` says the property is expected to carry personal data. Email or phone shaped values are reported in every property that does not say so.
- `maxDistinct` bounds the number of distinct values of a property seen in a stream, for properties that should be low-cardinality. It cannot be combined with `enum`.
- `funnel` is the order in which a user should first reach the listed events.
- `eqg validate-plan` and every other command refuse a malformed plan and list every problem with its path, for example `events.a.required[0]: "x" is not a declared property`. The JSON Schema file and the validator are checked against each other on structural cases in the tests; the checks across the file (a required property must be declared, a funnel step must be a declared event) are made by the validator only.

## How each check decides

**Stream line.** `event_id`, `name`, `user_id` and `ts` are required; `received_at` and `properties` are optional. `ts` and `received_at` are epoch milliseconds or ISO 8601 strings that carry an offset. A line that fails this is an `invalid-envelope` finding and is not checked further.

**Repeated ids.** The second and later copies of an `event_id` are reported and then skipped by every other check, so a duplicate with a schema error counts once. Only the id is compared: the same content under a new id is a different event as far as the tool can tell.

**Late and skewed.** An event is late when `received_at - ts` is greater than `--late-tolerance` (default 15 minutes) and skewed when `ts - received_at` is greater than `--skew-tolerance` (default 5 minutes). The defaults are placeholders, not recommendations; the output states the values used. Events without `received_at` are skipped by both checks, and the output says how many (`--require-received-at` makes that an envelope problem instead).

**Funnel order.** For each user the tool keeps the earliest `ts` of each funnel step. A user is reported once if a later step's earliest time is before an earlier step's. Equal times are not reported, and a missing earlier step is not reported, because a stream can begin in the middle of a funnel.

**Distinct values.** The first value that takes a property past `maxDistinct` is reported once for that property, with the line where it happened. After that the property is not tracked, so memory stays bounded.

**Sample ratio.** Chi-square statistic over users per arm against the planned split (weights are relative: `control=1,treatment=1` and `control=0.5,treatment=0.5` are the same plan), tail probability from the incomplete gamma function. The default threshold `--srm-alpha 0.001` is a common choice, not a tuned one. A user seen in more than one arm, a row in an arm that is not in the split, an arm with fewer than two users and an arm whose denominator sums to zero are findings too; those users and rows are left out of the numbers.

**Ratio interval.** For R = ȳ / x̄ over n units, the variance is

```
Var(R) ≈ (1/n) · (s²_y − 2 R s_xy + R² s²_x) / x̄²
```

with sample (n − 1) variances and covariance, and a normal interval R ± z·√Var(R) (default 95%). With the user as the unit, y and x are each user's totals; with the request as the unit they are the individual rows, so the same code gives both intervals. The difference between two arms adds their variances.

**CUPED.** On the per-user total of `y` with the per-user pre-period value `pre` as covariate: y_adj = y − θ(pre − mean(pre)), where θ is the slope of y on pre pooled over arms after centring each arm on its own mean. Users without a pre-period value get the mean. The adjusted outcome is compared between arms like any other per-user number. The reported variance ratio is the variance of the adjusted difference over the variance of the raw one. The uncertainty in θ is not added.

## Results

Every number below is read from a committed file under `results/` by `scripts/render-tables.ts`; none is typed in. Each section names the file and the commit the run was made at. The runs are synthetic, on one machine, and the generators, seeds and parameters are in the scripts (`scripts/synthetic.ts`, `scripts/simulate-coverage.ts`, `scripts/code-corpus.ts`, `scripts/fault-injection.ts`, `scripts/bench-runtime.ts`).

<!-- results:start (generated by scripts/render-tables.ts from results/*.json; do not edit by hand) -->

### Coverage of the 95% interval when requests are correlated within a user

Each setting is 2,000 simulated experiments per seed, 10 seeds (101 to 110). A cell is the mean over seeds of the share of intervals that contain the true ratio, with the lowest and highest seed in brackets. One seed of 2,000 experiments has a Monte Carlo standard error of about 0.49 percentage points at 95%.

| setting | users | true ratio | request-level interval | user-level interval (delta method) | mean width, request-level | mean width, user-level |
| --- | --- | --- | --- | --- | --- | --- |
| requests independent (icc 0) | 200 | 0.200 | 95.0% (94.4% to 95.9%) | 94.9% (94.5% to 96.0%) | 0.0351 | 0.0350 |
| icc 0.05 | 200 | 0.200 | 89.3% (88.1% to 90.3%) | 95.0% (94.3% to 95.7%) | 0.0351 | 0.0428 |
| icc 0.2 | 200 | 0.200 | 74.3% (73.4% to 75.1%) | 94.8% (94.0% to 95.5%) | 0.0350 | 0.0604 |
| icc 0.5 | 200 | 0.200 | 57.8% (55.5% to 60.2%) | 94.4% (93.6% to 95.3%) | 0.0350 | 0.0852 |
| icc 0.2, 50 users | 50 | 0.200 | 73.5% (71.9% to 76.0%) | 93.2% (92.5% to 94.0%) | 0.0698 | 0.1196 |
| icc 0.2, heavy users succeed more | 200 | 0.344 | 64.1% (62.7% to 65.5%) | 94.2% (93.6% to 95.0%) | 0.0416 | 0.0881 |

Source: `results/coverage/coverage.json`, run at commit `04e54b6`.

### Fault injection: streams

Each row injects 200 faults of one kind into a clean synthetic stream (3,000 users, 16,471 to 16,743 events), once for each of 5 seeds. A fault counts as detected when the tool reports the expected finding at the injected line (for the funnel rows, for the injected user). Rate is the mean over seeds with the lowest and highest seed in brackets. "Stray" counts findings that match no injected fault.

| fault | what was injected | injected (all seeds) | detected | rate | stray | why it is missed |
| --- | --- | --- | --- | --- | --- | --- |
| unknown-event | event name misspelled (last character dropped) | 1000 | 1000 | 100.0% | 0 |  |
| missing-required-property | a required property removed | 1000 | 1000 | 100.0% | 0 |  |
| unexpected-property | a property that is not in the plan added | 1000 | 1000 | 100.0% | 0 |  |
| type-integer-as-string | an integer property sent as a string | 1000 | 1000 | 100.0% | 0 |  |
| type-fractional-integer | an integer property sent with a fraction | 1000 | 1000 | 100.0% | 0 |  |
| type-boolean-as-string | a boolean property sent as the string "true" or "false" | 1000 | 1000 | 100.0% | 0 |  |
| enum-unlisted-value | an enum property set to a value that is not listed | 1000 | 1000 | 100.0% | 0 |  |
| enum-case-changed | an enum value with its first letter capitalised | 1000 | 1000 | 100.0% | 0 |  |
| enum-wrong-but-valid-value | an enum property swapped for a different listed value | 1000 | 0 | 0.0% | 0 | Both values are allowed by the plan, so a plan cannot call either wrong. |
| duplicate-delivery | an event delivered twice with the same event_id | 1000 | 1000 | 100.0% | 0 |  |
| duplicate-with-new-id | an event retried with a new event_id and everything else the same | 1000 | 0 | 0.0% | 0 | Only the event_id is compared; the same content under a new id is a different event as far as the tool can tell. |
| funnel-reordered | a user's first workspace_created moved before their signup_completed | 1000 | 1000 | 100.0% | 0 |  |
| funnel-step-lost | a user's signup_completed event removed, leaving later steps | 1000 | 0 | 0.0% | 0 | A stream can start in the middle of a funnel, so a missing earlier step is not reported; only steps seen out of order are. |
| late-arrival | received_at later than the 15 minute tolerance (16 minutes to 6 hours) | 1000 | 1000 | 100.0% | 0 |  |
| clock-ahead | a timestamp later than receive time by more than the 5 minute tolerance (6 minutes to 2 hours) | 1000 | 1000 | 100.0% | 0 |  |
| pii-email | an email address in an undeclared string property | 1000 | 1000 | 100.0% | 0 |  |
| pii-phone-parentheses | a phone number written (555) 010-0xxx | 1000 | 1000 | 100.0% | 0 |  |
| pii-phone-dashes | a phone number written 555-010-0xxx | 1000 | 1000 | 100.0% | 0 |  |
| pii-phone-international | a phone number written +44 20 7946 0xxx | 1000 | 1000 | 100.0% | 0 |  |
| pii-phone-digits-only | a phone number as ten bare digits | 1000 | 0 | 0.0% | 0 | Ten bare digits look like any numeric id, so the detector does not match them. |
| pii-email-spelled-out | an email address written "name dot x at example dot com" | 1000 | 0 | 0.0% | 0 | Only the usual local-part@domain shape is matched. |
| pii-person-name | a person's name | 1000 | 0 | 0.0% | 0 | A name has no fixed shape; the detector matches shapes, not meaning. |
| pii-street-address | a street address | 1000 | 0 | 0.0% | 0 | Same reason as names: no fixed shape. |
| truncated-line | a line cut off in the middle (invalid JSON) | 1000 | 1000 | 100.0% | 0 |  |
| missing-user-id | user_id missing from the envelope | 1000 | 1000 | 100.0% | 0 |  |
| timestamp-not-iso | ts written "2026-11-02 10:00:00" (no T, no offset) | 1000 | 1000 | 100.0% | 0 |  |

High cardinality: 80 signup events in a 600-user stream given unique referrer values (plan bound 40); 50 streams per seed, each also run without the injection as a control. Detected in 250 of 250 streams; flagged in 0 of 250 control streams.

Controls: the clean streams gave 0 findings in total across 5 seeds.

### Fault injection: source code

Each row injects 200 faults of one kind into a synthetic corpus of 400 tracker calls (the other 200 calls stay clean), once for each of 5 seeds. "Located" means the expected finding at the injected line. "Unverifiable" means the tool did not name the fault but reported the call as one it could not check, which still fails the run. "Missed" means no finding at all. "Stray" counts findings outside the injected calls.

| fault | what was injected | injected (all seeds) | located | unverifiable | missed | stray | why it is not located |
| --- | --- | --- | --- | --- | --- | --- | --- |
| unknown-event | event name misspelled (one character dropped) | 1000 | 1000 | 0 | 0 | 0 |  |
| missing-required-property | a required property left out of an object literal | 1000 | 1000 | 0 | 0 | 0 |  |
| unexpected-property | a property that is not in the plan added | 1000 | 1000 | 0 | 0 | 0 |  |
| type-integer-as-string | an integer literal written as a string | 1000 | 1000 | 0 | 0 | 0 |  |
| type-fractional-integer | an integer literal written with a fraction | 1000 | 1000 | 0 | 0 | 0 |  |
| type-boolean-as-string | a boolean literal written as a string | 1000 | 1000 | 0 | 0 | 0 |  |
| enum-unlisted-value | an enum property set to a value that is not listed | 1000 | 1000 | 0 | 0 | 0 |  |
| enum-case-changed | an enum value with its first letter capitalised | 1000 | 1000 | 0 | 0 | 0 |  |
| enum-wrong-but-valid-value | an enum property swapped for a different listed value | 1000 | 0 | 0 | 1000 | 0 | Both values are allowed by the plan, so a plan cannot call either wrong. |
| pii-email-literal | an email address literal in an undeclared string property | 1000 | 1000 | 0 | 0 | 0 |  |
| pii-phone-literal | a phone number literal (555) 010-0xxx | 1000 | 1000 | 0 | 0 | 0 |  |
| pii-digits-only-literal | a phone number literal as ten bare digits | 1000 | 0 | 0 | 1000 | 0 | Ten bare digits look like any numeric id, so the detector does not match them. |
| event-name-not-literal | the event name passed in a variable | 1000 | 1000 | 0 | 0 | 0 | Reported as non-literal-event-name: the tool says it cannot check the call, and the run fails. |
| event-name-in-constant-with-typo | a misspelled event name held in a const declared above the call | 1000 | 0 | 1000 | 0 | 0 | The tool reads only literals in the call, so it reports the call as unverifiable instead of naming the typo. |
| properties-in-variable | a required property missing from an object passed by variable | 1000 | 0 | 1000 | 0 | 0 | The properties are not an object literal, so the tool says it cannot read them. |
| spread-hides-missing-property | a required property missing, with a spread in the object literal | 1000 | 0 | 1000 | 0 | 0 | A spread may or may not supply the property, so the tool reports it as unverifiable. |
| wrapper-function-typo | a misspelled event name passed to a wrapper (logEvent) that is not a configured tracker | 1000 | 0 | 0 | 1000 | 0 | Only the configured tracker names are matched, so a wrapper is never seen unless it is passed with --tracker. |
| aliased-tracker-typo | a misspelled event name passed through const t = analytics.track | 1000 | 0 | 0 | 1000 | 0 | An alias has a different name from any configured tracker. |
| element-access-typo | a misspelled event name passed to analytics['track'] | 1000 | 0 | 0 | 1000 | 0 | Calls through bracket access are not matched. |
| type-mismatch-in-non-literal-value | an integer property given String(count) | 1000 | 0 | 0 | 1000 | 0 | A value that is not a literal is not compared; the run reports how many such values it skipped. |

Controls: 10,000 clean calls across 5 seeds gave 0 findings.

Source: `results/fault-injection/fault-injection.json`, run at commit `0d46a76`.

### Runtime of `eqg check-stream`

1,000,000 synthetic events from 180,355 users, 187 MiB of JSONL, 5 runs, each a fresh process. Machine: 13th Gen Intel(R) Core(TM) i7-13700HX, 24 logical CPUs, 29.7 GB RAM, win32 10.0.26200, Node v22.17.0. One laptop. Other programs were running during the runs; free RAM before each run is listed per run. No effort was made to quiet the machine.

| run | wall time (ms) | check time (ms) | peak memory (MB) | events per second | findings | free RAM before (GB) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 8,065 | 7,332 | 293 | 136,388 | 0 | 2.46 |
| 2 | 8,028 | 7,364 | 294 | 135,796 | 0 | 2.63 |
| 3 | 8,161 | 7,501 | 295 | 133,316 | 0 | 2.54 |
| 4 | 8,428 | 7,789 | 296 | 128,386 | 0 | 2.27 |
| 5 | 8,778 | 8,090 | 296 | 123,609 | 0 | 2.21 |
| median (range) | 8,161 (8,028 to 8,778) | 7,501 (7,332 to 8,090) | 295 (293 to 296) | 133,316 (123,609 to 136,388) | | |

Source: `results/runtime/runtime.json`, run at commit `0d46a76`.

### Mutation check

56 of 56 injected defects were caught by the tests; 0 survived and 0 could not be applied. Each defect is put into a copy of the code, one at a time, and the tests are run against the copy: first the test files nearest the changed file, then the whole suite before a defect is called a survivor.

<details><summary>All defects</summary>

| id | file | defect | outcome |
| --- | --- | --- | --- |
| L1 | `src/lint-code.ts` | a backtick string with no substitution is no longer read as a literal event name | killed by nearby tests |
| L2 | `src/lint-code.ts` | a value wrapped in `as` is no longer read through | killed by nearby tests |
| L3 | `src/lint-code.ts` | required properties are reported missing even when a spread may supply them | killed by nearby tests |
| L4 | `src/lint-code.ts` | a property set to undefined counts as present | killed by nearby tests |
| L5 | `src/lint-code.ts` | the enum test is inverted | killed by nearby tests |
| L6 | `src/lint-code.ts` | PII-shaped literals are reported even where the plan declares pii | killed by nearby tests |
| L7 | `src/lint-code.ts` | event names are looked up with inherited keys (constructor, toString) | killed by nearby tests |
| L8 | `src/lint-code.ts` | a non-literal event name is silently passed | killed by nearby tests |
| L9 | `src/lint-code.ts` | a scan that found no tracker calls passes | killed by nearby tests |
| L10 | `src/lint-code.ts` | syntax errors are not reported | killed by nearby tests |
| L11 | `src/lint-code.ts` | this.analytics.track is never matched | killed by nearby tests |
| L12 | `src/lint-code.ts` | literal type mismatches are not reported | killed by nearby tests |
| A1 | `src/plan.ts` | maxDistinct of zero is accepted | killed by nearby tests |
| A2 | `src/plan.ts` | inherited names count as declared events | killed by nearby tests |
| A3 | `src/plan.ts` | a one-step funnel is accepted | killed by nearby tests |
| A4 | `src/plan.ts` | duplicate enum values are accepted | killed by nearby tests |
| A5 | `src/plan.ts` | a fractional number matches the integer type | killed by nearby tests |
| S1 | `src/check-stream.ts` | an event exactly at the lateness tolerance is called late | killed by nearby tests |
| S2 | `src/check-stream.ts` | a clock exactly at the skew tolerance is called skewed | killed by nearby tests |
| S3 | `src/check-stream.ts` | equal funnel timestamps are called out of order | killed by nearby tests |
| S4 | `src/check-stream.ts` | duplicate event ids are not found | killed by nearby tests |
| S5 | `src/check-stream.ts` | the distinct-value bound is off by one | killed by nearby tests |
| S6 | `src/check-stream.ts` | a stream with no events passes | killed by nearby tests |
| S7 | `src/check-stream.ts` | PII-shaped values are reported even where the plan declares pii | killed by nearby tests |
| S8 | `src/check-stream.ts` | a required property with a false or zero value counts as missing | killed by nearby tests |
| S9 | `src/check-stream.ts` | an ISO timestamp without an offset is accepted | killed by nearby tests |
| S10 | `src/check-stream.ts` | a byte order mark is not removed | killed by nearby tests |
| S11 | `src/check-stream.ts` | a day is 86.4 seconds | killed by nearby tests |
| S12 | `src/check-stream.ts` | the line length limit is not applied | killed by nearby tests |
| S13 | `src/check-stream.ts` | events without received_at are not counted as unchecked | killed by nearby tests |
| T1 | `src/stats.ts` | the covariance term of the delta method has the wrong sign | killed by nearby tests |
| T2 | `src/stats.ts` | the ratio is not squared in the delta method | killed by nearby tests |
| T3 | `src/stats.ts` | the delta method divides by the mean of the denominator, not its square | killed by nearby tests |
| T4 | `src/stats.ts` | the variance of the denominator uses n instead of n - 1 | killed by nearby tests |
| T5 | `src/stats.ts` | the chi-square test has one degree of freedom too many | killed by nearby tests |
| T6 | `src/stats.ts` | the chi-square statistic is not divided by the expected count | killed by nearby tests |
| T7 | `src/stats.ts` | the control arm adds no variance to the difference | killed by nearby tests |
| T8 | `src/stats.ts` | the CUPED slope is halved | killed by nearby tests |
| T9 | `src/stats.ts` | the upper tail of the normal quantile has the wrong sign | killed by nearby tests |
| T10 | `src/stats.ts` | merging two sets of moments weighs them wrongly | killed by nearby tests |
| T11 | `src/stats.ts` | the series branch of the incomplete gamma function returns the wrong tail | killed by nearby tests |
| T12 | `src/stats.ts` | an interval is computed from a single unit | killed by nearby tests |
| R1 | `src/readout.ts` | a user in two arms is not noticed | killed by nearby tests |
| R2 | `src/readout.ts` | the sample ratio verdict is inverted | killed by nearby tests |
| R3 | `src/readout.ts` | an arm with one user gets an interval | killed by nearby tests |
| R4 | `src/readout.ts` | a row without x counts as zero requests | killed by nearby tests |
| R5 | `src/readout.ts` | an interval that excludes zero is never reported as such | killed by nearby tests |
| R6 | `src/readout.ts` | rows of an arm that is not in the plan are analysed | killed by nearby tests |
| R7 | `src/readout.ts` | the width ratio is upside down | killed by nearby tests |
| R8 | `src/readout.ts` | the request-level interval is built from user totals | killed by nearby tests |
| P1 | `src/pii.ts` | a phone shape is matched inside a longer digit run | killed by nearby tests |
| P2 | `src/pii.ts` | any text containing @ is called an email | killed by nearby tests |
| C1 | `src/cli.ts` | lint-code exits 0 whatever it finds | killed by nearby tests |
| C2 | `src/cli.ts` | running eqg with no command exits 0 | killed by nearby tests |
| C3 | `src/cli.ts` | check-stream passes a stream with exactly one finding | killed by nearby tests |
| C4 | `src/cli.ts` | validate-plan exits 0 for an invalid plan | killed by nearby tests |

</details>

Source: `results/mutation-check.json`, run at commit `ace752d`.

<!-- results:end -->

### How to read these

- **Coverage.** When requests are independent the two intervals agree. When requests of one user are correlated, the request-level interval is too narrow and its coverage falls well below 95%, more so as the correlation rises; the user-level interval stays near 95%. At 50 users the user-level interval covers a little less than nominal (the delta method is an approximation that needs enough users), so a small experiment gets a slightly optimistic interval from it too.
- **Fault injection.** The faults in the rows with 100% are built from the same rules the tool checks, so those rates show that the rules work as written on inputs of this shape. They say nothing about how often real faults look like these. The rows with low rates are the more useful part: they list what the tool cannot see, and why.
- **Runtime.** One laptop with other programs running; the range across five runs is part of the result.

## Limits

- **Synthetic data only.** The streams, code and experiments are generated here. The tool has not been run against production events or a real experiment platform.
- **The static check reads literals.** A constant that holds an event name, a value computed at run time, and properties built in a variable are not resolved; they are reported as unverifiable or, for a non-literal property value, counted as not compared. Calls through a wrapper function, an alias or bracket access (`analytics['track']`) are not seen unless the wrapper is passed with `--tracker`. Only `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs` and `.cjs` files are scanned (not `.d.ts`, and not `node_modules`, `dist`, `coverage` or `.git`); templates in other file types are not.
- **PII detection is by shape.** It matches the usual `name@domain.tld`, a phone number written with a leading `+`, and a North American number in three groups. Ten bare digits, a spelled-out email, names and addresses are not matched. A match is a hint, not proof.
- **The stream check keeps state in memory:** every event id, the earliest time of each funnel step per user, and a bounded set of values per bounded property.
- **The delta method is an approximation.** It assumes enough independent users for a normal interval; the coverage table shows it a little below 95% at 50 users. The tool does not correct for looking at many metrics, does not support sequential looks, and handles one pre-period covariate.
- **CUPED here is applied to a per-user total,** which is a different quantity from the ratio metric. It is not a variance reduction for the ratio interval.
- **Defaults are not tuned:** the lateness and skew tolerances, the 0.001 sample ratio threshold and the 95% level are settings to change.
- **The measurements are from one machine,** with other programs running, on Node 22 on Windows. CI runs the tests on Node 20 and 22 on Linux.

## Tests and the CI gate

```sh
npm run lint
npm run typecheck
npm test
```

The tests include arithmetic worked by hand in the test file (a four-user ratio interval, a chi-square statistic of exactly 2 on three arms, a CUPED example whose slope is 2 and whose variance falls to one sixth), reference values computed outside this code base, a check that the JSON Schema agrees with the validator, a test that regenerates the example files from their seeds and compares them with the committed ones, a test that each fault-injection family behaves as its row says, and a test that the tables in this README equal what the result files give. `npm run mutation-check` puts defects one at a time into a copy of the code and reports which ones the tests catch; its result is in the table above.

The workflow in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs lint, the type check, the build and the tests on Node 20 and 22. It then runs the gate on the clean samples, which must exit 0, and on the planted-fault samples and an empty stream, which must exit 1; a step fails if the exit code is anything else.

## Related work and references

- The delta-method variance of a ratio metric, and the point that users rather than requests are randomised so that requests from one user are correlated, are taken from the Knowledge Board page, "Notion's Knowledge Board", <https://labs.notion.com/knowledge-board> (shown as updated Oct 16, 2026). The page gives `Var(R) ≈ (1/n) · (σ²_Y − 2R σ_XY + R² σ²_X) / μ²_X` and does not say what `n` counts. This tool takes `n` as the number of units in the interval (users for the user-level interval, requests for the request-level one) and uses sample variances. Nothing here is checked against, or claimed about, how that page's numbers are produced.
- CUPED: A. Deng, Y. Xu, R. Kohavi and T. Walker, "Improving the Sensitivity of Online Controlled Experiments by Utilizing Pre-Experiment Data", WSDM 2013, <https://exp-platform.com/cuped/>.

## License

MIT, see [LICENSE](LICENSE).
