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
