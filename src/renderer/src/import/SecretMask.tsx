// SPDX-License-Identifier: GPL-3.0-or-later
import './import.css';

/** Beyond this many dots the mask stops growing — a 64-character password is not a wall. */
const MAX_MASK_DOTS = 12;

/**
 * A secret that is present but not shown.
 *
 * The **only** way this screen renders anything about a password, a note, or a hidden custom
 * value. It takes a length, never a value, because a component that accepted a value would
 * be a component someone could pass one to — and the file being previewed is a plaintext
 * dump of the user's entire vault.
 *
 * The dots are decorative and hidden from assistive tech; the spoken form is a sentence,
 * because a screen reader announcing "bullet bullet bullet bullet" twelve times per row is
 * worse than useless in a table of five records.
 */
export function SecretMask({
  length,
  what,
}: {
  readonly length: number;
  /** What is hidden, lower case and singular: "password", "note". */
  readonly what: string;
}): React.JSX.Element {
  if (length <= 0) {
    return <span className="kh-import-mask kh-import-mask--empty">No {what}</span>;
  }

  return (
    <span className="kh-import-mask">
      <span aria-hidden="true">{'•'.repeat(Math.min(length, MAX_MASK_DOTS))}</span>
      <span className="kh-visually-hidden">
        {what}, {length} character{length === 1 ? '' : 's'}, not shown
      </span>
    </span>
  );
}
