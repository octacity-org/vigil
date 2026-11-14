# 0019. Labeling protocol for precision

- **Status:** accepted
- **Date:** 2026-11-14
- **Decided by:** @BerkeDurdu
- **Discussion:** #73

## Context

Phase 3 measures precision on 50 findings labelled by two independent labelers (`docs/VIGIL.md` §10). The target is at least 70%; at n = 50 this has about ±13 points of uncertainty. The result decides whether the project returns to Phase 2, so the labelling must be hard to bias:

- **Who labels.** Labelers must not be the people who set the thresholds ([0015](0015-materiality-thresholds.md), [0018](0018-profit-cash-divergence-trigger.md)).
- **Independence.** Labelers must not see each other's answers.
- **One question.** The question must be the same for every finding and every labeler.
- **Disagreements.** The protocol must say how disagreements change the result.
- **Licensing.** Labels are published in the repository, but KAP-derived numbers are not ([0001](0001-license.md)).

## Options considered

For disagreements between the two labelers:

1. **Adjudication by a third person.** Both labels are kept. A third person settles disagreements, and the target applies to the adjudicated result.
2. **Correct only if both say yes.** No third person is needed, but precision is biased downwards.
3. **Average of the two labelers' precision.** No third person is needed, but a finding can count as half right.

## Decision

Option 1, with this protocol.

**Roles**

| Role | Who | Must not be |
|---|---|---|
| Coordinator | Draws the sample (#75), sends the files, collects the answers, publishes them | A labeler or the adjudicator |
| Labeler A, labeler B | Label all 50 findings | Anyone who set or proposed a threshold, the coordinator |
| Adjudicator | Settles disagreements after both labelers have submitted | Anyone who set a threshold, a labeler |

The people are named in the round's issue (#76) before the sample is drawn. Thresholds in 0015 and 0018 were set by @BerkeDurdu, who can coordinate but cannot label or adjudicate.

**The question**

Every finding gets the same question, in Turkish:

> **Bu bulgu, bir finans analistinin bilmek isteyeceği önemli bir değişikliği gösteriyor mu?**
> (Does this finding show a material change that a financial analyst would want to know about?)

| Answer | When |
|---|---|
| `evet` (yes) | The change is real and large enough that an analyst following the company would want to look at it, even if the filing explains it |
| `hayir` (no) | Anything else; one reason is required |

| Reason for `hayir` | Meaning |
|---|---|
| `onemsiz` | The numbers are right, but the change is small for this company, seasonal or routine |
| `yontem` | The finding comes from the method, not the company. Examples: comparing periods with a different consolidation scope, or a reclassification that moves amounts between rows |
| `veri_hatasi` | A number in the finding differs from the filing on KAP. Each one is reported as a bug after the round |
| `diger` | Any other reason; the note is required |

A note of one or two sentences is optional for `evet` and required for `diger`.

**Examples**

The labeler instructions include at least two `evet` and two `hayir` examples, one for each `hayir` reason where possible. Examples come from a quarter that is not sampled and are fixed before the sample is drawn. They show the reasoning, not a list of finding types to accept or reject.

**What labelers may use**

- **Allowed:**
  - The finding card: numbers, sources, bridge, and the thresholds with the computed values.
  - The filing on KAP and its notes.
  - The company's earlier filings.
- **Not allowed:**
  - Share prices and news published after the filing date (hindsight).
  - The other labeler's answers.
  - Asking the people who set the thresholds about a specific finding.

**Form and independence**

1. **Sample.** The coordinator draws the sample with the seeded script (#75) after the thresholds are frozen, and commits the seed and the finding ids before labelling starts.
2. **Files.** Each labeler gets their own CSV. The 50 findings are in a different random order for each labeler, and labelers are not told the order of the other file.

   | Column | |
   |---|---|
   | `finding_id` | Identifies the finding |
   | `disclosure_id` | The KAP disclosure |
   | `finding_type` | S1, S2 or S3 |
   | `answer` | `evet` or `hayir` |
   | `reason` | One of the four reasons, for `hayir` |
   | `note` | Free text |

   No KAP numbers go in the file; the numbers stay on the finding card in each person's local Vigil.
3. **Return.** Labelers send their file privately to the coordinator, not in the repository, an issue or a shared chat. They do not discuss findings with each other until both files are in.
4. **No changes.** A submitted file is final.
5. **Adjudication.** After both files arrive, the coordinator gives the adjudicator only the findings where the answers differ, with both answers and notes. The adjudicator writes one answer and reason for each.
6. **Publishing.** The coordinator publishes both label files and the adjudication file unchanged in one pull request, under `docs/validation/round-N/`.

**Results (#77)**

| Result | How |
|---|---|
| Precision | Adjudicated `evet` / 50, with a 95% Wilson interval. The ≥ 70% target applies to this number |
| Per-labeler precision | Reported for each labeler separately |
| Per-type precision | Reported for S1, S2 and S3, marked as indicative when a type has fewer than 20 findings |
| Agreement | Raw agreement and Cohen's kappa between labelers A and B, before adjudication |
| `veri_hatasi` count | Reported separately. These findings count as wrong |

- **Changes after labelling.** If thresholds or definitions change after labelling, the next measurement uses a new sample and, where possible, new labelers (`VIGIL.md` §10).
- **Recall.** Recall on the 20 known events is outside this protocol. The events are chosen before the findings list is produced.

## Reasoning

- **Adjudication over the alternatives.** It gives one answer per finding, so precision is a count, not an average. Keeping both raw labels and the agreement score shows how much the result depends on the adjudicator.
- **Fixed question.** It stops the label from drifting towards "would this move the price", which needs hindsight.
- **Separating `yontem` and `veri_hatasi`.** A low precision then points to what must be fixed: thresholds, method or parser.
- **Private return and fixed order.** They keep the labels independent without needing a special tool.

## Consequences

- Phase 3 needs at least four people: a coordinator, two labelers and an adjudicator. None of the three non-coordinator roles can be @BerkeDurdu. The labelers should have financial statement knowledge (`finance-knowledge`).
- The sampling script (#75) writes one shuffled CSV per labeler with the columns above.
- The report script (#77) reads the three files and computes the results above.
- The instructions with the examples are written before round 1 (#76) and published with it.
- **Revisit:** if agreement is low (kappa below 0.4), the question or the examples are unclear. Fix them before the next round, not the labels of this one.
