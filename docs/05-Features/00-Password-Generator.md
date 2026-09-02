# Password generator

> Four generation modes and the entropy maths behind them.
> Current reference. Implemented by `src/main/generator/`.
>
> **Status: the engine is built and tested; the IPC channel and the UI are not.** See §7.

---

## 1. Modes

| Mode            | What it produces                                                                                      | Entropy per character                       |
| --------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `random`        | Length 8–256, any mix of lower / upper / digits / symbols                                             | 6.55 bits at the full 94-character alphabet |
| `passphrase`    | 3–20 words from the EFF large wordlist, with a separator, capitalisation and optional digit injection | 12.9 bits per **word**                      |
| `pronounceable` | Strict consonant/vowel alternation, plus fixed digits and a symbol                                    | ~3.25 bits                                  |
| `pin`           | Digits only, length 4–32                                                                              | 3.32 bits                                   |

Everything draws from `src/main/crypto/random.ts` — the project CSPRNG, with unbiased
`randomInt` and a Fisher–Yates shuffle. `Math.random()` is banned project-wide by lint.

---

## 2. The wordlist is the real EFF list

7,776 words, embedded verbatim, SHA-256 recorded in the file header. A guard test pins the
count, uniqueness, and prefix-freedom.

**It contains four hyphenated entries** — `drop-down`, `felt-tip`, `t-shirt`, `yo-yo` — so a
naïve "all lowercase a–z" assertion would fail against the genuine list. The guard pins
those four by name instead, which means a future "cleanup" has to be a deliberate act rather
than a silent one. It also means the default hyphen separator cannot be reversed to recover
the original words; the tests split on `.` for that reason.

Prefix-freedom is asserted (0 prefix pairs across all 7,776) because it is what lets a
passphrase survive losing its separators.

---

## 3. `requireEachClass` is charged for, not given away

Guaranteeing at least one character from every enabled class **shrinks** the search space —
it excludes every string missing a class. Reporting the unconstrained entropy would overstate
the result.

`estimateEntropyBits` subtracts the correction via inclusion–exclusion over the enabled
classes (roughly 0.15 bits at length 20 with four classes). The implementation states plainly
that this is an _upper bound_ on the sampler's real entropy: place-and-shuffle is supported
on exactly that constrained set but is not perfectly uniform over it, so the truth is a hair
lower still.

### The anti-bias guard

The obvious implementation places the guaranteed characters at the **front**, which makes
their positions predictable and materially reduces real-world strength. The generator places
them and then shuffles.

The test generates ~2,000 passwords and checks the distribution of where the guaranteed
digit lands. Fault injection — removing the shuffle — fails it with `expected 0 to be greater
than 90.42`: position 0 never held a digit.

---

## 4. Exclusions are applied to the alphabet, not the output

The natural mistake is to generate and then strip excluded characters. That **changes the
length**, silently producing a shorter password than asked for.

This is worth recording because of what the fault injection found: stripping afterwards does
_not_ fail the "never emits an excluded character" test — the characters genuinely are gone.
It fails only the **length** assertion. So the length test is not a formality; it is the sole
guard against that specific defect, and the test file says so.

If exclusions empty an entire enabled class, the generator **throws** rather than silently
dropping the class and producing a weaker password. Error messages name the class but never
echo the user's exclusion string back.

Entropy always reflects the alphabet that actually remains after exclusions.

---

## 5. Pronounceable trades entropy for memorability, and says so

Strict single-letter alternation rather than variable-width clusters, because clusters make
the length inexact and the entropy unreportable from the configuration alone. `q`, `x` and
`y` are dropped (18 consonants, 5 vowels) so alternation cannot emit `qixuqy`.

Digits and a symbol are appended at fixed positions and contribute **no positional entropy**,
which is stated rather than quietly counted. A test asserts pronounceable is below 0.6× the
entropy of `random` at equal length.

---

## 6. One plan feeds both entry points

`generatePassword` and `estimateEntropyBits` run the same planning step, so the number shown
in the UI and the password produced can never describe different configurations. A test
asserts `result.entropyBits === estimateEntropyBits(options)`.

The symbol set excludes space, backslash, backtick and both quote characters — the five that
break shells, CSV exports and login forms — leaving 28 symbols.

---

## 7. Not built yet

- The IPC channel and the generator UI.
- Session generation history, per-site rule memory, and generate-and-replace inside a
  credential (which must auto-version the previous password).
- `GENERATOR_LIMITS` and `GENERATOR_DEFAULTS` currently live in
  `src/main/generator/generator.ts`. When the UI lands it must read them across the IPC
  contract rather than restating them — otherwise the "no second list" rule is broken the
  moment someone types `min={8}` into a slider.
- `GeneratedPassword.password` is a plain string. The field name and its doc comment flag it
  as secret material; whether it becomes a `SecretString` is a decision for whoever wires the
  IPC path.
