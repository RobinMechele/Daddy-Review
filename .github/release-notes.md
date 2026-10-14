## What's new in 1.3

- **Others**: a new tab with the open PRs that don't ask for you (yet). Click **+** to add yourself as a reviewer; it moves to *To review*. Picked repositories in Settings? Then *Others* only shows PRs from those, and new ones there pop up.
- **Settings no longer flicker**: switching something doesn't make the panel slide in again or jump to the top, and switches flip right away.
- Narrow windows: the tabs fit again.

## Also in 1.2

- **Pick your repositories** per organization (Settings → *All repositories*); *Only these* hides the rest (your own PRs always stay).
- **More of your PRs are found**: also PRs for teams you're in through a group, and big organizations are read to the end.
- **To review is your queue**: a PR for your team stays there until *you* vote, also when a teammate already approved it. *Done* is only what you approved.
- **Drafts**: a *Ready for review* popup when a draft is published.

> On 1.1 or newer, Daddy Review updates itself. Still on 1.0.0? Install this version once by hand.

## Install

**Windows:** download **`Daddy-Review-Setup-x.y.z.exe`** below and run it. It installs for your user (no admin needed) and starts right away.

> The installer isn't code-signed yet, so Windows may say *"Windows protected your PC"*. Click **More info → Run anyway**.

Then click **Sign in with Microsoft**: your browser opens, pick your work account, done. No PAT needed. If you've used `az login` on this PC, it signs you in by itself.

Daddy Review starts with Windows and keeps watching your pull requests from the tray. Switch that off in Settings or the tray menu.

macOS (`.dmg`) and Linux (`.AppImage`) builds are attached too. Windows and Linux update themselves; on macOS the app tells you when a new version is out.
