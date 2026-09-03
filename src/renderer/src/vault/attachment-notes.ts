// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentAddView } from '@shared/model/attachment.js';

/**
 * Turning what the attachment engine found into what the user is told.
 *
 * Its own module, and not only because a component file exporting a function breaks fast
 * refresh. This is the whole reason the engine computes these checks: a filename sanitised
 * silently is a rename the user never learns about, and a mime mismatch nobody sees is a
 * check that may as well not run. Pure, so the wording can be tested without rendering
 * anything — which is what makes it worth asserting the wording at all.
 */
/**
 * What to say about a file that was just attached.
 *
 * Built as a list of sentences rather than one string so the caller decides the separator,
 * and so a finding can be added without re-punctuating the others.
 */
export function addNotes(view: AttachmentAddView): readonly string[] {
  const notes: string[] = [];

  if (view.deduped) {
    // Worth saying: the user picked a file and the vault did not grow. Silence here reads
    // as the attach having failed.
    notes.push('This file was already in the vault, so it was linked rather than stored twice.');
  }
  if (view.name.changed) {
    notes.push(`Saved as “${view.name.sanitised}”.`);
  }
  if (view.name.disguised) {
    // `invoice.pdf.exe`. The engine refuses to rename it into something harmless, because
    // that would hide what it is — so this is the only place the user can be told.
    notes.push('The name hides a second extension. Treat it as untrusted.');
  } else if (view.name.executable) {
    notes.push('This is an executable file. Keyhold stores it, but will never run it.');
  }
  if (view.mime.status === 'mismatch') {
    notes.push(
      `Claimed ${view.mime.claimed}, is actually ${view.mime.detected ?? 'unrecognised'}.`
    );
  }
  if (view.warnLarge) {
    notes.push('It is a large file — the vault will take longer to open and save.');
  }

  return notes;
}
