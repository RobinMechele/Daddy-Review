# Daddy Review

A desktop app that helps you do more pull request reviews on **Azure DevOps**. It shows what's waiting for you, picks the best one to do next, pops up when something new arrives and keeps you going with a daily goal and streak.

**Install it like any other app. No PAT, no server, no setup.** Sign in with your Microsoft work account and it finds your organizations on its own.

![Daddy Review](docs/dashboard.png)

## Install

Download the installer for your system from the latest build:

- **Windows:** `Daddy-Review-Setup-x.y.z.exe`. Run it; it installs for your user (no admin) and starts.
- **macOS:** `Daddy-Review-x.y.z-arm64.dmg`
- **Linux:** `Daddy-Review-x.y.z.AppImage`

Where to download: the repository's **Releases** page, or **Actions → Build desktop app → latest run → Artifacts**.

> The installer isn't code-signed yet. Windows may show *"Windows protected your PC"*: click **More info → Run anyway**. On macOS, right-click the app → **Open** the first time.

Then click **Sign in with Microsoft**: your browser opens, you pick your work account, and you're done. If you've used `az login` on this PC, it signs you in by itself.

## What it does

| | |
|---|---|
| **Next up** | Ranks your queue: required reviews, quick wins (few files), PRs updated since your vote and long-waiting ones go first. Shows size (XS–XL) and an estimated review time. |
| **One-click votes** | Approve, approve with suggestions, wait for author, reject or snooze right from the list. Every vote has *Undo*. |
| **Review flow** | *Review now* opens the PR in your browser. When you come back, the assistant asks how it went, records your vote and hands you the next one. |
| **Popups** | Windows notifications for new review requests, new pushes after your review, votes on *your* PRs, and a nudge when PRs wait too long (work hours only). Click one to open the PR. |
| **Lives in the tray** | Closing the window keeps it watching in the background; the taskbar shows how many PRs are waiting. Starts with Windows (switch off in Settings or the tray menu). |
| **Mini window** | ⧉ opens a small always-on-top window with your next PR, so reviews stay in sight while you work. |
| **All orgs, teams too** | Finds all your Azure DevOps organizations and includes PRs assigned to your teams. |
| **Goal & streak** | Daily review goal, 7-day chart and a workday streak (weekends never break it). |

<p>
  <img src="docs/assistant.png" width="66%" alt="Assistant asking how the review went">
  <img src="docs/mini.png" width="28%" alt="Always-on-top mini window">
</p>

**Keyboard:** `J`/`K` move · `Enter` details · `O` open · `A` approve · `W` wait · `S` snooze · `N` next · `R` refresh · `P` mini window · `?` all shortcuts.

## Sign-in without a PAT

Daddy Review signs in the same way Git Credential Manager and `az login` do:

- **Microsoft account**: it opens your normal browser at Microsoft's sign-in page (so your company's single sign-on and MFA just work) and listens on a random `localhost` port only until Microsoft sends you back. It uses Microsoft's public Visual Studio client, so there's no app registration and no secret, and it only asks for the Azure DevOps permission.
- **Azure CLI**: if you've run `az login`, it uses `az account get-access-token`, with zero clicks.

Everything stays on your PC: the sign-in is kept in your user profile (`%APPDATA%\Daddy Review`). *Sign out* in Settings deletes it.

## Troubleshooting

- **"No access" for an organization**: it may belong to another Entra tenant where you're a guest. Sign out and sign in with that account, or switch the org off in Settings.
- **My organization is missing**: Settings → Organizations → paste its URL (`https://dev.azure.com/your-org`).
- **No popups**: check Windows *Do not disturb* / notification settings for *Daddy Review*.
- **Quit completely**: right-click the tray icon → *Quit Daddy Review*.
- Log file: `%APPDATA%\Daddy Review\daddy-review.log`.

## Development

Needs Node.js 22+.

```
npm install
npm start          # run the desktop app
npm run demo       # the app against a fake Azure DevOps with live activity
npm test           # engine tests (sign-in, queue, votes, events, ...)
npm run test:app   # drives the real desktop app (on Linux: xvfb-run -a npm run test:app)
npm run dist       # build the installer for this OS into dist/
```

Every push builds the Windows, macOS and Linux installers in GitHub Actions. Pushing a tag like `v1.0.1` also publishes them as a GitHub Release.

```
electron/  main.js (window, tray, notifications, sign-in, autostart) · preload.js (the UI's only bridge)
server/    core.js (engine API) · auth.js (Microsoft / Azure CLI) · loopback.js (desktop sign-in)
           ado.js (Azure DevOps REST) · inbox.js (polling, events, stats) · logic.js (ranking, diffing)
           index.js (browser dev mode, used by the tests)
public/    the UI: index.html · styles.css · js/
demo/      fake Azure DevOps + Microsoft sign-in for the demo and the tests
```
