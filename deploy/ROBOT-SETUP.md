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
2. Signed in as the robot account, install **Autoflow Robot** (Dashboard → Settings → Downloads),
   or — before installers are published — use a clone of the repository with
   [uv](https://docs.astral.sh/uv/) installed.
3. In PowerShell (as the robot account, *not* as administrator):

   ```powershell
   .\deploy\windows\install-robot.ps1 -Server https://rpa.company.local:8443 -Key afe_xxxxxxxx
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

## Troubleshooting

| Symptom | What to check |
|---|---|
| Robot shows *Offline* | Is the account signed in? Look at `%LOCALAPPDATA%\Autoflow\Robot\logs\robot.log` |
| "Unknown robot" in the log | The robot was removed in the dashboard — enroll it again |
| Runs fail with "element not found" on desktop apps | Screen locked or minimized session — see step 3 |
| Certificate errors after IT renewed the server certificate | Delete `%LOCALAPPDATA%\Autoflow\Robot\robot.json` and enroll again |
