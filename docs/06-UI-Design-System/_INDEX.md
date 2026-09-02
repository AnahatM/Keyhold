# 06 · UI design system

| Page                                                           | What it covers                                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`00-Tokens-And-Themes.md`](./00-Tokens-And-Themes.md)         | The colour token vocabulary, why themes are TypeScript rather than CSS, the eight built-in themes, the accent derivation and the runtime contrast problem it solves, density/type/motion, and the two guards |
| [`01-Layout-And-Components.md`](./01-Layout-And-Components.md) | The three-pane shell and how it degrades, native window state and the menu, the component rules and why each exists, and what is deliberately not built yet                                                  |

| [`02-App-Chrome.md`](./02-App-Chrome.md) | Toasts and their queue policy, why undo and error toasts never auto-dismiss, the native `<dialog>` decision, tooltip timing, honest progress, and the six fault injections |

**The hard rule:** every colour is a `--kh-color-*` token. There are no hardcoded colours
anywhere, and two guard tests enforce it.
