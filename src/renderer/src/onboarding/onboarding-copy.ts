// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The security copy of the first-run flow, in one place.
 *
 * Ordinary interface copy lives inline in the JSX, as it does everywhere else in this
 * codebase. These four strings do not, for one reason: they are **claims**, and a claim
 * that exists in two places drifts. The moment "there is no recovery" is worded slightly
 * differently on two screens, one of them is softer, and the softer one is the one somebody
 * remembers.
 *
 * ## Why each is worded the way it is
 *
 * **{@link NO_RECOVERY_HEADING}** says *reset*, not *recover*. Every other password manager
 * has trained people that a forgotten password is a mild inconvenience with a link at the
 * bottom of the login form. "Reset" is the word they are looking for, so it is the word
 * that has to be denied.
 *
 * **{@link NO_RECOVERY_EXPLANATION}** gives the mechanism before the consequence — no
 * account, no server, therefore nobody to ask — because a consequence with no mechanism
 * reads as a policy someone could be talked out of. It ends with the action, not the fear:
 * write it down. That is genuinely the right advice, and a threat model that assumes an
 * attacker in your house is a different threat model from the one this app is built for
 * (see `docs/00-Overview/03-Threat-Model.md`).
 *
 * **{@link NO_RECOVERY_ACKNOWLEDGEMENT}** is first person, present tense, and states the
 * loss rather than the mechanism. It is deliberately shorter than the explanation above it,
 * because it is the sentence a person actually has to hold in their head while they tick a
 * box. "I understand there is no recovery mechanism" is a sentence about the software;
 * "if I lose this password, I lose the vault" is a sentence about them.
 *
 * **{@link ENCRYPTION_CLAIM}** is the only positive security claim the flow makes, and it
 * is deliberately narrow. "Encrypted on your device" is true. "Unhackable", "military
 * grade" and "nobody can ever read it" are not, and the threat model says plainly what
 * Keyhold does not defend against. A password manager that overstates its guarantees is
 * worse than one that is candid, because people calibrate their behaviour to what they
 * believe is true.
 */

export const NO_RECOVERY_HEADING = 'There is no way to reset this password.';

export const NO_RECOVERY_EXPLANATION =
  'Keyhold has no account and no server, so there is nobody to ask and nothing to reset. ' +
  'If you forget your master password, your vault stays encrypted — for you exactly as much ' +
  'as for anyone else. Write it down and keep it somewhere physically safe.';

export const NO_RECOVERY_ACKNOWLEDGEMENT =
  'I understand: if I lose this password, I lose the vault.';

export const ENCRYPTION_CLAIM =
  'Your vault is encrypted on this device with a key derived from your master password. ' +
  'It is never uploaded anywhere, because there is nowhere to upload it to.';
