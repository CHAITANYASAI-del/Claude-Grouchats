# Fonts

The viewer renders Claude's responses in **Anthropic Sans** and headers in **Anthropic Serif**
(the same faces Claude uses). These are **Anthropic's proprietary typefaces** and are therefore
**not committed to this public repository**.

To run the viewer with the exact Claude look, place these WOFF2 files here:

```
AnthropicSans-Text-Regular.woff2
AnthropicSans-Text-Italic.woff2
AnthropicSans-Text-Medium.woff2
AnthropicSans-Text-Semibold.woff2
AnthropicSans-Text-Bold.woff2
AnthropicSerif-Display-Medium.woff2
AnthropicSerif-Display-Semibold.woff2
AnthropicSerif-Display-Bold.woff2
```

Without them, the viewer gracefully falls back to Helvetica (body) and Georgia (headers) via the
CSS `@font-face` fallback stacks — everything still works, only the typeface differs.
