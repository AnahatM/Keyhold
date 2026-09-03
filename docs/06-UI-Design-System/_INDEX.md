# 06 · UI design system

| Page                                                                           | What it covers                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`00-Tokens-And-Themes.md`](./00-Tokens-And-Themes.md)                         | The colour token vocabulary, why themes are TypeScript rather than CSS, the built-in themes, the accent derivation and the runtime contrast problem it solves, density/type/motion, and the two guards |
| [`01-Layout-And-Components.md`](./01-Layout-And-Components.md)                 | The three-pane shell and how it degrades, the tool views as a fourth region, native window state and the menu, the component rules and why each exists, and what is still deliberately not built       |
| [`02-App-Chrome.md`](./02-App-Chrome.md)                                       | Toasts and their queue policy, why undo and error toasts never auto-dismiss, the native `<dialog>` decision, tooltip timing, honest progress, and the fault injections                                 |
| [`03-Command-Palette-And-Shortcuts.md`](./03-Command-Palette-And-Shortcuts.md) | One shortcut registry as the only list, the three booleans that gate every key, why there is deliberately no copy-password command, and one ranked list over commands and credentials                  |
| [`04-Onboarding-And-Theme-Studio.md`](./04-Onboarding-And-Theme-Studio.md)     | The exact no-recovery wording and why each sentence is phrased that way, that nothing typed is ever persisted, and the three-tier contrast decision including why the legibility floor has no override |

**The hard rule:** every colour is a `--kh-color-*` token, and the rule is guarded from both
sides. Over the theme _definitions_: every token resolves in every theme, every
foreground/background pair passes WCAG AA in every theme, and every theme × accent-preset
combination stays readable including under hostile input. Over the _source tree_:
`tools/no-hardcoded-colours.test.ts` scans every `.ts`/`.tsx`/`.css` file under `src/` and fails
on a colour literal outside the token layer, with a short allow-list whose entries each state a
reason. That last one exists because the theme-definition guards structurally cannot see a
literal in, say, a `BrowserWindow` option — which is exactly where one was found (doc-audit
finding F5).

**What is reachable, and what is not.** The shell, the tool views, the chrome layer and the
command palette are all mounted. The theme studio is reachable through the `settings` tool
view. The **onboarding flow is not mounted anywhere**, and the studio's native `.keeptheme`
file dialogs are unwired — there is no `kh:theme:*` channel, so it falls back to the browser
file transport. Each page's status blockquote says so precisely.
