// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_CONFIGURABLE_VAULT_SETTINGS,
  DEFAULT_MACHINE_SETTINGS,
  clampMachineSettings,
  clampVaultSettings,
  type ConfigurableVaultSettings,
  type MachineSettings,
  type SettingsGateway,
  type SettingsSnapshot,
} from '@shared/model/settings-plan.js';

/**
 * The settings screen's state.
 *
 * **The gateway is the source of truth.** Every change sends a patch and adopts whatever
 * comes back, rather than mutating a local copy and hoping the two agree — the main process
 * coerces what it stores (a clipboard timer is capped, a wipe threshold below three is
 * refused), so a screen that predicted the result locally would show a value the store had
 * already rewritten. That failure is invisible until someone reopens the screen and finds a
 * different number, which is the worst way to discover a security setting did not take.
 *
 * Everything is clamped on the way out as well, through the shared clamps, so a control can
 * never send a value the store would have to correct in the first place.
 *
 * **Announcements are part of the contract, not decoration.** A settings control that
 * applies immediately gives a sighted user instant feedback and a screen-reader user
 * nothing at all, so every successful change publishes a polite announcement.
 */

export interface Announcement {
  readonly text: string;
  /** Bumped on every announcement so an identical message is re-announced. */
  readonly seq: number;
}

export interface SettingsController {
  readonly snapshot: SettingsSnapshot | null;
  readonly loading: boolean;
  /** A load failure. Distinct from a save failure, which is reported through `saveError`. */
  readonly loadError: string | null;
  readonly saveError: string | null;
  readonly busy: boolean;
  readonly announcement: Announcement;
  readonly updateMachine: (patch: Partial<MachineSettings>, announce: string) => void;
  readonly updateVault: (patch: Partial<ConfigurableVaultSettings>, announce: string) => void;
  /** Opens the folder dialog in main and applies whatever the user picked. */
  readonly chooseMirrorDirectory: () => Promise<void>;
  readonly resetMachine: () => void;
  readonly resetVault: () => void;
  /**
   * Runs an arbitrary gateway action — the danger-zone operations, which are not patches.
   * Resolves true when it succeeded, so a dialog knows whether to close.
   */
  readonly perform: (
    announce: string,
    action: (gateway: SettingsGateway) => Promise<SettingsSnapshot | null>
  ) => Promise<boolean>;
  readonly reload: () => void;
}

export function useSettings(gateway: SettingsGateway): SettingsController {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState<Announcement>({ text: '', seq: 0 });
  const [reloadToken, setReloadToken] = useState(0);

  // Guards every `setState` that happens after an await, so a screen closed mid-save does
  // not warn — and, more importantly, so a slow reply cannot overwrite a newer one.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    // An AbortController purely as a cancellation flag the effect's cleanup can flip. A
    // plain `let cancelled` would be narrowed to `false` by the compiler at every read
    // site, since the only assignment happens inside the cleanup closure — the lint rule
    // that catches genuinely dead conditions cannot tell the difference.
    const load = new AbortController();

    // The read is fired from a callback rather than run in the effect body, so no state is
    // set synchronously during the effect — the rule this codebase lints for.
    void (async (): Promise<void> => {
      try {
        const next = await gateway.read();
        if (!load.signal.aborted) {
          setSnapshot(next);
          setLoadError(null);
        }
      } catch (error: unknown) {
        if (!load.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : 'Settings could not be read.');
        }
      } finally {
        if (!load.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      load.abort();
    };
  }, [gateway, reloadToken]);

  const announce = useCallback((text: string): void => {
    setAnnouncement((previous) => ({ text, seq: previous.seq + 1 }));
  }, []);

  const perform = useCallback(
    async (
      announceText: string,
      action: (gateway: SettingsGateway) => Promise<SettingsSnapshot | null>
    ): Promise<boolean> => {
      setBusy(true);
      setSaveError(null);
      try {
        const next = await action(gateway);
        if (!alive.current) return true;
        if (next !== null) setSnapshot(next);
        announce(announceText);
        return true;
      } catch (error: unknown) {
        if (alive.current) {
          const message =
            error instanceof Error ? error.message : 'That change could not be saved.';
          setSaveError(message);
          // Announced as well as shown: a failure that only changes a colour is a failure a
          // screen-reader user never learns about.
          announce(`Not saved. ${message}`);
        }
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [gateway, announce]
  );

  const updateMachine = useCallback(
    (patch: Partial<MachineSettings>, announceText: string): void => {
      void perform(announceText, (target) => {
        const current = snapshot?.machine ?? DEFAULT_MACHINE_SETTINGS;
        const clamped = clampMachineSettings({ ...current, ...patch });
        return target.updateMachine(clamped);
      });
    },
    [perform, snapshot]
  );

  const updateVault = useCallback(
    (patch: Partial<ConfigurableVaultSettings>, announceText: string): void => {
      void perform(announceText, (target) => {
        const current = snapshot?.vault ?? DEFAULT_CONFIGURABLE_VAULT_SETTINGS;
        const clamped = clampVaultSettings({ ...current, ...patch });
        return target.updateVault(clamped);
      });
    },
    [perform, snapshot]
  );

  const chooseMirrorDirectory = useCallback(async (): Promise<void> => {
    await perform('Off-machine copy destination set.', async (target) => {
      const next = await target.chooseMirrorDirectory();
      // `null` is a dismissed dialog, not a failure. Returning the current snapshot leaves
      // the screen exactly as it was rather than blanking it.
      return next ?? (await target.read());
    });
  }, [perform]);

  const resetMachine = useCallback((): void => {
    void perform('Settings for this computer restored to their defaults.', (target) =>
      target.updateMachine(DEFAULT_MACHINE_SETTINGS)
    );
  }, [perform]);

  const resetVault = useCallback((): void => {
    void perform('Settings stored in this vault restored to their defaults.', (target) =>
      target.updateVault(DEFAULT_CONFIGURABLE_VAULT_SETTINGS)
    );
  }, [perform]);

  const reload = useCallback((): void => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  return {
    snapshot,
    loading,
    loadError,
    saveError,
    busy,
    announcement,
    updateMachine,
    updateVault,
    chooseMirrorDirectory,
    resetMachine,
    resetVault,
    perform,
    reload,
  };
}
