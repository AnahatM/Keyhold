// SPDX-License-Identifier: GPL-3.0-or-later
import { Button } from '../components/Button.js';
import { ErrorState, LoadingState } from '../components/Feedback.js';
import { GeneratorForm } from './GeneratorForm.js';
import { useGeneratorLimits } from './generator-limits.js';
import './generator.css';

/**
 * The generator panel, with its three states.
 *
 * This is the boundary that turns "we may not have the engine's limits yet" into "we do" —
 * everything below it is handed a `GeneratorLimitsView` and never has to reason about its
 * absence. That is why the form is a separate component rather than a branch inside this
 * one: a hook cannot be called conditionally, and a form that had to cope with `null`
 * limits would be one `?? 8` away from restating a bound the engine owns.
 *
 * The empty, loading and error states are the house set (`Feedback.tsx`), for the reason
 * that file gives: a view shipped without them shows a blank rectangle the first time
 * anyone opens it.
 */

export interface GeneratorPanelProps {
  /** Given a generated password to keep. Omitted on a screen with nowhere to put one. */
  readonly onUse?: ((secret: string) => void) | undefined;
  readonly useLabel?: string | undefined;
  /** Produce one on mount, so the panel is never an empty box. */
  readonly autoGenerate?: boolean;
}

export function GeneratorPanel({
  onUse,
  useLabel,
  autoGenerate = true,
}: GeneratorPanelProps): React.JSX.Element {
  const { state, retry } = useGeneratorLimits();

  if (state.status === 'loading') {
    return <LoadingState label="Reading the generator’s settings" rows={2} />;
  }

  if (state.status === 'error') {
    return (
      <ErrorState
        title="The generator is not available"
        description={state.message}
        action={
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <GeneratorForm
      limits={state.view}
      onUse={onUse}
      useLabel={useLabel}
      autoGenerate={autoGenerate}
    />
  );
}
