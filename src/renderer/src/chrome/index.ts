// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The app chrome — roadmap Phase 15.
 *
 * Five systems, each usable without the other four: toasts, a modal and its confirm
 * variant, tooltips, progress, and the named empty states. Only `ToastProvider` has to be
 * mounted; everything else is rendered where it is needed.
 *
 * A barrel rather than five import paths because these are consumed from every view in the
 * app, and one import site is the difference between the chrome being used and being
 * reimplemented locally by whoever could not remember where `ConfirmDialog` lived.
 */

export { ToastProvider, type ToastProviderProps } from './ToastProvider.js';
export { useToast, politenessFor, type ToastApi, type ToastOptions } from './toast-context.js';
export type {
  Toast,
  ToastAction,
  ToastInput,
  ToastPauseReason,
  ToastState,
  ToastTone,
} from './toast-types.js';
export { MAX_QUEUED_TOASTS, MAX_VISIBLE_TOASTS, defaultDurationMs } from './toast-queue.js';

export { Modal, type ModalProps } from './Modal.js';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog.js';
export { AUTOFOCUS_ATTRIBUTE } from './focus.js';

export { Tooltip, type TooltipPlacement, type TooltipProps } from './Tooltip.js';
export { createTooltipGroup, type TooltipGroup } from './tooltip-timing.js';

export { ProgressBar, type ProgressBarProps, type ProgressTone } from './ProgressBar.js';

export { AppEmptyState, type AppEmptyStateProps } from './AppEmptyState.js';
export {
  EMPTY_STATE_KINDS,
  EMPTY_STATE_PRESETS,
  type EmptyStateKind,
  type EmptyStatePreset,
} from './empty-state-presets.js';
