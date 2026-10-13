# Daddy Review

Your pull request review sidekick for **Azure DevOps**. It shows what needs your review, picks the best one to do next, pops up when something new arrives and keeps you going with a daily goal and streak.

**No PAT.** Sign in with your Microsoft work account (or reuse your `az login`). Installable as a desktop app.

![Dashboard](docs/dashboard.png)

## Get it running (Windows)

1. **Node.js 18+** (one time): `winget install OpenJS.NodeJS.LTS`, or get it from [nodejs.org](https://nodejs.org).
2. Download this repo (Code → Download ZIP) and unzip it somewhere permanent, e.g. `C:\Apps\Daddy-Review`.
3. Double-click **`Install Daddy Review.cmd`**.
   It runs in the background, starts with Windows and opens <http://localhost:4280>.
4. Click **Sign in with Microsoft** and pick your work account.
5. Click **Install app** (or the ⊕ icon in Edge/Chrome's address bar). You now have *Daddy Review* in your Start menu and taskbar, with a badge showing how many PRs wait for you.

Just want to try it once? Double-click **`Start Daddy Review.cmd`** instead. Closing that window stops it.

macOS / Linux: `npm start` (or `npm run install-app` to run in the background at login).

No Azure DevOps at hand? **`npm run demo`** runs everything against a fake Azure DevOps with live activity.

## What it does

| | |
|---|---|
| **Next up** | Ranks your queue: required reviews, quick wins (few files), PRs updated since your vote and long-waiting ones float to the top. Shows size (XS–XL) and an estimated review time. |
| **One-click votes** | Approve, approve with suggestions, wait for author, reject, or snooze, right from the list. Every vote has *Undo*. |
| **Review flow** | *Review now* opens the PR in Azure DevOps. When you come back the assistant asks how it went, records your vote and hands you the next one. |
| **Popups** | Desktop notifications for new review requests, new pushes after your review, votes on *your* PRs, and a nudge when PRs wait too long (work hours only). They also work while the app window is closed (Windows toast). |
| **Mini window** | ⧉ opens a small always-on-top window with your next PR, so reviews stay in sight while you work. |
| **All orgs, teams too** | Finds all your Azure DevOps organizations automatically and includes PRs assigned to your teams. |
| **Goal & streak** | Daily review goal, 7-day chart and a workday streak (weekends never break it). |

<p>
  <img src="docs/assistant.png" width="66%" alt="Assistant asking how the review went">
  <img src="docs/mini.png" width="28%" alt="Mini always-on-top window">
</p>

**Keyboard:** `J`/`K` move · `Enter` details · `O` open · `A` approve · `W` wait · `S` snooze · `N` next · `R` refresh · `P` mini window · `?` all shortcuts.

## Sign-in without a PAT

Daddy Review is a small local server (`localhost:4280`) plus a web app. It signs you in the same way Git Credential Manager does for Azure Repos:

- **Microsoft account**: standard OAuth (authorization code + PKCE) with Microsoft's public Visual Studio client and a `localhost` redirect. No app registration and no secret needed. It asks only for the Azure DevOps permission.
- **Azure CLI**: if you've run `az login`, it uses `az account get-access-token` silently, with zero clicks.

Your refresh token is stored in `%USERPROFILE%\.daddy-review\auth.json`, readable only by you. The server only listens on `127.0.0.1`/`::1` and refuses requests from other websites. *Sign out* in Settings deletes the token.

## Troubleshooting

- **"No access" for an organization**: it may be connected to another Entra tenant where your account is a guest. Sign out and sign in with that account, or switch the org off in Settings.
- **My organization is missing**: Settings → Organizations → paste its URL (`https://dev.azure.com/your-org`).
- **No popups**: allow notifications when asked (Settings → Popups → *Allow*), and check Windows *Do not disturb*/Focus.
- **No "Install app" button**: use Edge or Chrome. In Edge it's under ⋯ → Apps → *Install Daddy Review*.
- **Port 4280 is taken**: set `DADDY_PORT=4281` before starting.
- Logs from the background service: `%USERPROFILE%\.daddy-review\server.log`.

## Uninstall

Double-click **`Uninstall Daddy Review.cmd`** (stops it and removes it from startup). Remove the app window via its ⋯ menu → *Uninstall*. Delete `%USERPROFILE%\.daddy-review` to forget everything.

## Development

No dependencies, just Node 18+.

```
npm test          # unit + end-to-end tests (real server against a fake Azure DevOps)
npm run demo      # try the UI with simulated activity
npm run icons     # re-render PNG icons (needs Playwright)
```

```
server/   index.js (HTTP + CLI) · auth.js (Microsoft / Azure CLI sign-in) · ado.js (Azure DevOps REST)
          inbox.js (polling, events, stats) · logic.js (ranking, diffing) · notify.js · autostart.js
public/   index.html · styles.css · sw.js · js/ (app logic, views incl. assistant, mini window)
demo/     fake Azure DevOps + Microsoft sign-in used by the demo and the tests
```
