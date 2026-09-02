// SPDX-License-Identifier: GPL-3.0-or-later

import { ExportDialogBody } from './ExportDialogBody.js';
import type { ExportGateway } from './export-gateway.js';

/**
 * The export dialog's public face.
 *
 * It exists to be the one place that decides "closed means unmounted". Everything the
 * dialog holds while it is open — a chosen format, a scope, a typed confirmation and a
 * parcel passphrase — dies with the component rather than being cleared by a reset the next
 * person to touch this file could forget to call.
 *
 * That is not tidiness. A dialog that hid rather than unmounted would reopen with the
 * confirmation phrase still in its field, which would turn the type-to-confirm into an
 * ordinary button from the second export onwards — and the second time is exactly when
 * people stop reading. It is the same reason this feature offers no "remember my choice".
 */
export interface ExportDialogProps {
  readonly open: boolean;
  readonly gateway: ExportGateway;
  /**
   * Ids selected in the credential list right now.
   *
   * Ids only — never projections and never records. The dialog has no use for a record's
   * contents, so it is not given any, and "does the export dialog touch a credential value?"
   * is answered by reading this one line.
   */
  readonly selectedIds: readonly string[];
  readonly onClose: () => void;
}

export function ExportDialog({
  open,
  gateway,
  selectedIds,
  onClose,
}: ExportDialogProps): React.JSX.Element | null {
  if (!open) return null;
  return <ExportDialogBody gateway={gateway} selectedIds={selectedIds} onClose={onClose} />;
}
