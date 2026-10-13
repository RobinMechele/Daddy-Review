## What's new in 1.1

- **Automatic updates**: new versions download in the background; restart when it suits you (or it installs the next time the app quits).
- **Comments on your PRs**: see which threads are waiting for your answer, and get a popup when someone comments.
- **Profile pictures** from Azure DevOps.
- **Search** the list (press `/`).
- **Only during work hours**: optional, no popups in the evening or weekend.
- **Ctrl+Alt+R** shows or hides Daddy Review from anywhere.
- **Friday recap** of your week.
- **Personal Microsoft accounts** can sign in too.

> Coming from 1.0.0? Install this version once by hand; from here on Daddy Review updates itself.

## Install

**Windows:** download **`Daddy-Review-Setup-x.y.z.exe`** below and run it. It installs for your user (no admin needed) and starts right away.

> The installer isn't code-signed yet, so Windows may say *"Windows protected your PC"*. Click **More info → Run anyway**.

Then click **Sign in with Microsoft**: your browser opens, pick your work account, done. No PAT needed. If you've used `az login` on this PC, it signs you in by itself.

Daddy Review starts with Windows and keeps watching your pull requests from the tray. Switch that off in Settings or the tray menu.

macOS (`.dmg`) and Linux (`.AppImage`) builds are attached too. Windows and Linux update themselves; on macOS the app tells you when a new version is out.
