// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { mountReact } from '../chrome/test-dom.js';
import { Button } from './Button.js';

/**
 * Guard: an icon name on a `Button` draws an icon, and never the word.
 *
 * `icon` is typed `IconName | ReactNode`, and `ReactNode` accepts a `string` — so
 * `icon="close"` typechecked at four call sites and rendered the literal text. The modal's
 * close button read as the word "close" for some time and nothing failed; a screenshot of an
 * unrelated feature is what found it.
 *
 * Fault injection: the `<Icon>` wrapper removed so the name renders directly. The first case
 * fails with the name as text content, which is exactly the shipped bug.
 *
 * The prop is now `IconName` and nothing else. `IconName | ReactNode` was the first fix and
 * the linter was right to refuse it: that union collapses back to `ReactNode` and would have
 * accepted the bug again.
 */
describe('a button given an icon name', () => {
  it('renders an svg, not the name', () => {
    const tree = mountReact(<Button icon="close" iconOnlyLabel="Close" />);

    expect(tree.container.querySelector('svg')).not.toBeNull();
    expect(tree.container.textContent).not.toContain('close');
    tree.unmount();
  });

  it('renders the label beside it when there is one', () => {
    const tree = mountReact(<Button icon="save">Go</Button>);

    expect(tree.container.querySelector('svg')).not.toBeNull();
    expect(tree.container.textContent).toContain('Go');
    tree.unmount();
  });

  it('renders nothing extra when given no icon', () => {
    const tree = mountReact(<Button>Plain</Button>);

    expect(tree.container.querySelector('svg')).toBeNull();
    tree.unmount();
  });
});
