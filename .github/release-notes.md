## What's new in 1.2

- **Pick your repositories**: Settings → under an organization → *All repositories*. Every active PR in the repositories or projects you pick shows up, also when it doesn't ask for you. Switch on *Only these* to hide the rest (your own PRs always stay).
- **More of your PRs are found**: PRs for your teams now show up when you're in the team through a group (e.g. an Entra ID group), and organizations with hundreds of PRs are read to the end.
- **To review is your queue**: a PR assigned to your team stays in *To review* until *you* vote, also when a teammate already approved it (it's marked and ranked lower). *Done* is only what you approved.
- **Drafts**: when a draft is published you get a *Ready for review* popup.
- Settings shows how many open PRs each organization has, and how many come in through your teams.

> On 1.1, Daddy Review updates itself. Still on 1.0.0? Install this version once by hand.

## Install

**Windows:** download **`Daddy-Review-Setup-x.y.z.exe`** below and run it. It installs for your user (no admin needed) and starts right away.

> The installer isn't code-signed yet, so Windows may say *"Windows protected your PC"*. Click **More info → Run anyway**.

Then click **Sign in with Microsoft**: your browser opens, pick your work account, done. No PAT needed. If you've used `az login` on this PC, it signs you in by itself.

Daddy Review starts with Windows and keeps watching your pull requests from the tray. Switch that off in Settings or the tray menu.

macOS (`.dmg`) and Linux (`.AppImage`) builds are attached too. Windows and Linux update themselves; on macOS the app tells you when a new version is out.
