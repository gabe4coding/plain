# Planner benchmark

`src/computer/planner.ts` turns one sentence into plan items with two Jev requests (see
[computer use](../computer-use.mdx#one-sentence-plan-and-do)). `scripts/benchmark-planner.mjs` plans the 41
sentences of `scripts/planner-cases.json` with the live model and compares each plan with the expected
one (case-insensitive, a leading "the" and trailing punctuation ignored).

```
node scripts/benchmark-planner.mjs --runs 3 --out /tmp/new.json --compare /tmp/base.json
```

## 2026-09-24, jev-1.13.0

| Change | Pass rate | Kept |
|---|---|---|
| Baseline: one Noul per "and"/comma ("does a new action begin here?"); argument spans need confidence ≥ 0.5 | 76.8% (63/82) | |
| Spans taken without a confidence gate; a dot splits only before a space or the end; "Calculator app" → "Calculator" | 87.8% (72/82) | yes |
| Split by one Choice among the whole readings of each ambiguous piece | 97.6% (80/82) | yes |
| Target question asks for "the thing to act on … with where it is" | 95.1% (117/123) | no: fixed "Rock and Roll in the genre list", broke one-word targets ("Cancel", "Apply") |
| Final, 3 runs | 97.6% (120/123), median 3,206 tokens per sentence | |

What mattered:

- **Overlapping options split the probability.** Argument options are every run of words, so "the OK button"
  and "OK button" are both right and share the probability (0.61/0.36, confidence 0.57; "the report file"
  0.46/0.40, confidence 0.41). A confidence gate rejected good picks; the top option is taken unless it is
  `none`. The action question keeps its gate: its options are distinct.
- **Judge whole readings, not single boundaries.** Asked per "and" in isolation, the split was near 0.5 and
  flipped between runs ("buy milk | and eggs"). Offered as complete readings ("1. type salt 2. pepper in the
  box" vs "1. type salt and pepper in the box"), Jev chose right every time.
- **Examples in instructions leak.** An example phrase that matched words of the sentence ("milk and eggs")
  pushed every boundary to "no" (0.10–0.32). Keep instructions general.

## Real voice session, 2026-09-24

Eleven sentences from a live `pwvoice` session (Whisper transcripts, mishearings included: "write" heard
as "right") were added to the cases (52 in all, `"real": true`). They exposed what the tidy sentences
did not: typing with no field named, commas inside the typed text, "next" as a word of the target.

| Change | Pass rate | Kept |
|---|---|---|
| Baseline with the real sentences | 84.6% (88/104) | |
| Spans trim punctuation at their edges only ("Hello, how are you" keeps its comma); "next" no longer a hard split; typing with no field named targets "the focused text field" | 91.3% (95/104) | yes |
| Argument questions state their premise ("suppose it asks to type…") | 91.3% | no: no change |
| `none` wins only against all the spans together ("none" 0.27 lost to 0.23 + 0.19 + … of overlapping spans) | 92.3% (96/104) | yes |
| Split question says typed text may follow the field and contain commas | 92.3% | no: no change |
| A piece that is "not an instruction" right after a failed piece is joined back and routed again (third request, only then) | 96.2% (100/104) | yes |

A second session added five more (57 in all): 93.0% before, then

| Change | Pass rate | Kept |
|---|---|---|
| Double quotes dropped from spans (dictation emphasis: `Click on "Create Note" button`); with a field named and no text judged, the text is the sentence minus the verb and the field phrase ("write a law in the text area", "a law" a misheard "hello") | 96.5% (110/114) | yes |
| Same, verb found after trimming | 97.4% (111/114) | yes |

Known failures: "Click Rock and Roll in the genre list" targets "the genre list"; "Enter in the text
field search a flight to Rome…" leaves "search" out of the text (ambiguous for a person too).

## Scroll left and right, 2026-10-16

`plain-computer do` rejected a planned `scroll: "left: …"` or `"right: …"`: the desktop parser took only `up` and
`down`. The desktop now scrolls in all four directions, and the planner builds its scroll step from the same
direction list. Its Jev requests did not change: for every case, with first-option and with scroll answers in
each direction, main and the branch send identical requests and give identical plans (354/354).
Two cases were added (59 in all): "Scroll right in the timeline" and "scroll the photo strip to the left".

| Run, 3 runs each, jev-1.13.0 | Pass rate |
|---|---|
| main | 96.6% (171/177), median 3,557 tokens per sentence |
| branch | 96.0% (170/177), median 3,557 tokens per sentence |

The one difference is Jev variance: "Press the OK button" was `unknown` ("not sure what to do") in 1 of 3 runs
on the branch. Both new cases passed 3/3 on both.
