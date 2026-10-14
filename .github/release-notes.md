## What's new in 1.5

- **Your comments resolved**: on PRs you review you see how many of your comments are still open. Once the author has resolved them all you get **one** popup (not one per comment). If you had asked for changes, the PR comes back to *To review*, marked *Comments resolved*.

## Also in 1.4

- **Review in the app**: *Review now* opens the PR right here. Every changed file with its diff, comments on their lines, **+** to comment on any line, reply, resolve, mark files as viewed, and vote. *Next PR* takes you to the next one. Clicking a popup or *Review* in the mini window opens it here too.
  Prefer Azure DevOps? Settings → *Review inside the app* off.
- The check mark in the goal ring stands upright again.

> On 1.1 or newer, Daddy Review updates itself. Still on 1.0.0? Install this version once by hand.

## Install

**Windows:** download **`Daddy-Review-Setup-x.y.z.exe`** below and run it. It installs for your user (no admin needed) and starts right away.

> The installer isn't code-signed yet, so Windows may say *"Windows protected your PC"*. Click **More info → Run anyway**.

Then click **Sign in with Microsoft**: your browser opens, pick your work account, done. No PAT needed. If you've used `az login` on this PC, it signs you in by itself.

Daddy Review starts with Windows and keeps watching your pull requests from the tray. Switch that off in Settings or the tray menu.

macOS (`.dmg`) and Linux (`.AppImage`) builds are attached too. Windows and Linux update themselves; on macOS the app tells you when a new version is out.
