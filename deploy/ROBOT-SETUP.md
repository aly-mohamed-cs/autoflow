# Setting up a robot computer

A robot is a Windows computer (a virtual machine is ideal) that runs published automations
unattended. It connects **out** to the Orchestrator, so no inbound firewall rules are needed.

## 1. Prepare the computer

- Windows 10/11 Pro or Enterprise, 8 GB RAM, the applications the automations use (Edge,
  Excel, the ERP client...).
- Create a dedicated Windows account for the robot, e.g. `COMPANY\rpa.robot01`. Give it access to
  the shared folders and applications the automations need — and nothing more.
- Sign in once with that account and open each application the automations use (so first-run
  dialogs are out of the way).

## 2. Install and enroll

1. In the dashboard: **Robots → Add robot → Create enrollment key**. Copy the command it shows.
2. Signed in as the robot account, download **Autoflow Robot** (Dashboard → Settings → Downloads)
   and unzip it into a folder **the robot account owns**, for example `C:\Autoflow\Robot`
   (create it as that account; not under Program Files). The robot updates itself there.
   Before installers are published you can use a clone of the repository with
   [uv](https://docs.astral.sh/uv/) installed instead (it then updates with `git pull`).
3. In PowerShell (as the robot account, *not* as administrator), in that folder:

   ```powershell
   .\install-robot.ps1 -Server https://rpa.company.local:8443 -Key afe_xxxxxxxx
   ```

   If the server uses a self-signed certificate, the robot prints its fingerprint. Compare it with
   the one in the dashboard dialog, then run the command again with `-TrustCertificate`.

The robot now starts every time this account signs in, restarts within a minute if it stops,
and appears as **Online** in the dashboard.

## 3. Make it unattended

Desktop automation (clicking in applications) needs a signed-in, **unlocked** desktop:

- **Automatic sign-in** for the robot account. Use Microsoft's
  [Sysinternals Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon) — it stores
  the password encrypted instead of in plain text.
- **No lock screen / screen saver.** `install-robot.ps1` turns off sleep and the screen saver for the
  account; also make sure no Group Policy forces a lock on this computer.
- **Don't disconnect with the X of Remote Desktop** — that locks the session. To check on a
  virtual machine, use the hypervisor console instead, or sign out of RDP with
  `tscon %sessionname% /dest:console` (run as administrator) so the desktop stays active.

Browser-only automations also work on a locked screen, but desktop steps do not.

## Updates

Robots update themselves. When the administrator copies a new robot package to the server
(`update-server.ps1 -Installers`), each robot notices within a few hours — or at once with
**Robots → ⋯ → Update now** — and, as soon as it isn't running anything:

1. downloads the package and checks its checksum,
2. unpacks it next to the current version and checks it starts,
3. restarts on the new version. If the new version doesn't start within two minutes, the robot
   goes back to the previous one by itself and the dashboard shows why.

Progress is in `<install folder>\.update\update.log`. Automatic updates can be turned off on the
**Robots** page; robots then only update with **Update now**.

Robots on 0.2.0 or older don't have this yet: reinstall them once from the new package (unzip
over the old folder while the robot is stopped, or into a new folder and run `install-robot.ps1`
there). From then on they update by themselves.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Robot shows *Offline* | Is the account signed in? Look at `%LOCALAPPDATA%\Autoflow\Robot\logs\robot.log` |
| "Unknown robot" in the log | The robot was removed in the dashboard — enroll it again |
| Runs fail with "element not found" on desktop apps | Screen locked or minimized session — see step 3 |
| Certificate errors after IT renewed the server certificate | Delete `%LOCALAPPDATA%\Autoflow\Robot\robot.json` and enroll again |
