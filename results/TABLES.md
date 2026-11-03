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
