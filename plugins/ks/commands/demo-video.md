---
description: Create automated product demo videos using Webreel (Vercel Labs CLI) for KarmaSuite features
---

# /ks:demo-video — Automated Product Demo Video Creator

This skill guides you through creating a product demo video using **Webreel** (Vercel Labs CLI). You'll describe the feature, Claude generates the config, records the video, and optionally shares it.

---

### Step 1: Gather Context

**What feature or page do you want to demo?** (e.g., "Fund Repository overview tab", "expense allocation workflow", "report generation")

> Claude will auto-detect the ticket number from `.claude/ks/state.yml` if available. Describe the user journey you want to capture — what actions should be recorded.

Once you answer, Claude will also ask:

**What is the base URL of the app to record against?** (default: `http://localhost:3000`)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎬  DEMO VIDEO SETUP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Feature  : <detected from answer>
Ticket   : <from state.yml or "N/A">
Base URL : <from answer or http://localhost:3000>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### Step 2: Generate Webreel Config

Based on your description, Claude generates two files:

**Config file** → `workflow/jaswanth/automated-demo-video-generation/configs/<name>.config.json`

```json
{
  "$schema": "https://webreel.dev/schema/v1.json",
  "outDir": "workflow/jaswanth/automated-demo-video-generation/videos/",
  "baseUrl": "<BASE_URL>",
  "viewport": { "width": 1440, "height": 900 },
  "defaultDelay": 500,
  "include": ["workflow/jaswanth/automated-demo-video-generation/steps/login.json"],
  "videos": {
    "<video-name>": {
      "url": "<path>",
      "waitFor": "<selector>",
      "output": "<video-name>.mp4",
      "fps": 60,
      "quality": 80,
      "steps": []
    }
  }
}
```

**Login step file** → `workflow/jaswanth/automated-demo-video-generation/steps/login.json`

```json
{
  "steps": [
    { "navigate": { "url": "/sign-in" } },
    { "wait": { "selector": "input[type='email']" } },
    { "click": { "selector": "input[type='email']" } },
    { "type": { "text": "$KS_DEMO_EMAIL", "selector": "input[type='email']" } },
    { "click": { "selector": "input[type='password']" } },
    { "type": { "text": "$KS_DEMO_PASSWORD", "selector": "input[type='password']" } },
    { "click": { "text": "Sign in" } },
    { "wait": { "selector": ".dashboard, [data-testid='app-shell']", "timeout": 10000 } }
  ]
}
```

Claude will show you the generated config and ask:

**Does this config look correct? Would you like to adjust any steps, selectors, or the demo flow before proceeding?**

---

### Step 3: Validate & Preview

Claude validates the config syntax first:

```bash
npx webreel validate -c workflow/jaswanth/automated-demo-video-generation/configs/<name>.config.json
```

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧  VALIDATION RESULT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅  Config is valid — no syntax errors
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then Claude asks:

**Would you like to preview the demo in a visible browser before recording?** (Preview runs through the steps without recording — good for verifying selectors and timing.)

If yes, Claude runs:
```bash
npx webreel preview -c workflow/jaswanth/automated-demo-video-generation/configs/<name>.config.json
```

---

### Step 4: Record

Claude records the video:

```bash
npx webreel record -c workflow/jaswanth/automated-demo-video-generation/configs/<name>.config.json --verbose
```

> **Before running:** Make sure the following env vars are set:
> - `KS_DEMO_EMAIL` — demo account email
> - `KS_DEMO_PASSWORD` — demo account password

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎬  RECORDING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Config   : configs/<name>.config.json
Output   : videos/<video-name>.mp4
FPS      : 60
Quality  : 80
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

After recording completes:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📁  RECORDING COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅  Output : workflow/jaswanth/automated-demo-video-generation/videos/<video-name>.mp4
   Size   : <file size>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### Step 5: Review & Iterate

**Are you happy with the recording, or would you like to make changes?**

- If **yes** → proceed to Step 6
- If **no** → describe what to change (timing, selectors, missing steps, etc.) and Claude will:
  1. Update the config
  2. Re-validate
  3. Re-record automatically

To re-apply overlays without re-recording (e.g., if only visual compositing changed):
```bash
npx webreel composite -c workflow/jaswanth/automated-demo-video-generation/configs/<name>.config.json
```

---

### Step 6: Optional Polish (Manual)

> ⚠️ This step is **not automated** — it requires manual action.

For higher-quality polish, consider uploading the MP4 to:
- **[Clueso](https://clueso.io)** — AI-powered product demo editor
- **[Trupeer](https://trupeer.ai)** — AI video editor for product demos

These tools can add voiceover, callouts, chapter markers, and branding. Upload the file at:

```
workflow/jaswanth/automated-demo-video-generation/videos/<video-name>.mp4
```

---

### Step 7: Share

**Where would you like to share this recording?**

Options:
1. **Slack channel** — Claude composes and sends a message via webhook
2. **Linear ticket** — Claude adds a comment with the recording link
3. **Skip** — You'll share it manually

If **Slack**: Claude will compose a message like:
```
🎬 New demo video: <Feature Name>
📁 File: <path or uploaded link>
<optional description>
```
...and send it to the appropriate channel.

If **Linear**: Claude will add a comment to the ticket with the video path/link.

---

## Webreel Quick Reference

### Installation
```bash
pnpm add webreel
# or: npm install webreel
```

### Key CLI Commands
```bash
npx webreel init --name <name> --url <url>    # scaffold config
npx webreel validate -c <config>              # check syntax
npx webreel preview -c <config>               # visible browser, no recording
npx webreel record -c <config> --verbose      # record video
npx webreel composite -c <config>             # re-apply overlays only
npx webreel install --force                   # re-download Chrome + ffmpeg
```

### Available Step Actions
| Action | Description |
|--------|-------------|
| `pause` | Wait `ms` milliseconds |
| `click` | Click by `text` or `selector` |
| `key` | Press key (e.g. `"mod+s"`) |
| `type` | Type text into a field |
| `scroll` | Scroll by `x`/`y` or to a `selector` |
| `wait` | Wait for `selector` or `text` |
| `screenshot` | Capture a screenshot frame |
| `drag` | Drag from/to coordinates |
| `moveTo` | Move cursor to element |
| `navigate` | Navigate to a URL |
| `hover` | Hover over element |
| `select` | Select dropdown option |

### File Locations
| Type | Path |
|------|------|
| Configs | `workflow/jaswanth/automated-demo-video-generation/configs/` |
| Step files | `workflow/jaswanth/automated-demo-video-generation/steps/` |
| Videos | `workflow/jaswanth/automated-demo-video-generation/videos/` |

### Auth Environment Variables
```bash
export KS_DEMO_EMAIL="demo@example.com"
export KS_DEMO_PASSWORD="your-password"
```

---

## Rules

- Ask **one question at a time** — never dump multiple questions in a single message
- Auto-detect ticket number from `.claude/ks/state.yml` but never require it
- Always validate config before recording (`webreel validate`)
- Always offer a preview step before recording
- Default viewport is **1440×900** (macbook-air), FPS **60**, quality **80**
- Use `$KS_DEMO_EMAIL` and `$KS_DEMO_PASSWORD` env vars — never hardcode credentials in config files
- Config files always go in `workflow/jaswanth/automated-demo-video-generation/configs/`
- Step files always go in `workflow/jaswanth/automated-demo-video-generation/steps/`
- Output videos always go in `workflow/jaswanth/automated-demo-video-generation/videos/`
- Clueso/Trupeer polish is informational only — never attempt to automate it
- When sharing to Slack, always use the channel specified in the Slack template — never offer alternatives
- If `webreel` is not installed, prompt the user to run `pnpm add webreel` before proceeding
- No worktree guard needed — this skill works anywhere in the repo
