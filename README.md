# gpt5-thinking-injection


> A tiny Tampermonkey userscript that primes ChatGPT with a thinking directive and keeps it there. It is **entirely vibe‑coded™**: more intuition than specification, more vibes than docs.

> *“Please think extensively before answering!!!”*

---

## What this does

* Prefills the ChatGPT composer with a **thinking directive** and a blank line in new and ongoing chats.
* Provides a small **on‑page toggle UI** (right side) and an **Alt+R** hotkey.


### About “GPT‑5 Thinking”

As of today, this script aims to nudge ChatGPT into **Thinking** behavior and—based on observation—*appears* to switch to the Thinking model behind the scenes via prompt injection. **No guarantees** it will continue to work; it may stop at any time. **No support** is provided.

---

## Install

1. Install **Tampermonkey** (Chrome/Edge/Firefox/Safari).
2. Create a new userscript and paste the contents of `userscript.user.js` from this repo.
3. Visit `https://chat.openai.com/` or `https://chatgpt.com/`.
4. You’ll see a small floating toggle on the right.

**Toggle behavior**

* **ON:** The composer is prefixed and kept warm for your next turn.
* **OFF:** Any existing prefix in the composer is removed immediately.

---

## Usage

Start a new chat or continue an existing one. The composer is prefilled with:

```
Please think extensively before answering!!!

```

Type your message below it, or overwrite it—your call.

**Hotkey:** `Alt + R` toggles the feature globally (state is stored in `localStorage`).

---

## Settings (edit in the script)

```js
const MODE = {
  // Core behavior
  prefixEveryMessage: true,
  autoPrimeOnNewChat: true,
  refillAfterSend: true,
  autoInsertAfterAssistant: true,
  autoSendAfterAssistant: false,

  // Streaming heuristics
  assistantStableWindowMs: 700,
  assistantStableMaxWaitMs: 6000,
  guardWhileAssistantStreaming: true,

  // Timings & debug
  debounceMs: 150,
  primeCooldownMs: 2500,
  afterAssistantDelayMs: 600,
  refillWaitMaxMs: 30000,
  refillPollMs: 120,
  debug: false
};

// The directive text
const PHRASE = 'Please think extensively before answering!!!';
```

---

## Compatibility

* Domains: `chat.openai.com`, `chatgpt.com`.

**Privacy:** No network calls, no analytics—state is kept in `localStorage`.

---

## Known quirks

* Some editors normalize `<br>` tags. This script uses **real blocks** (`<p>/<div>`) to create the blank line reliably.
* If ChatGPT radically changes its DOM, these vibe‑coded heuristics may need… new vibes.

---

## FAQ

**Does this actually enable “GPT‑5 Thinking”?**

That’s the goal. Empirically it currently appears to trigger the Thinking model via prefix injection. This is not guaranteed and can break without notice.


**Is this allowed?**

It’s a client‑side convenience. Use responsibly and respect the platform’s terms.

**Support?**

None. This is hobbyware—use at your own risk.

---

## Contributing

PRs welcome! Please test on both `chat.openai.com` and `chatgpt.com`. If you see the prefix disappear mid‑stream, open an issue with browser/version and a minimal reproduction.

---

## License

MIT. Go forth and preface.
