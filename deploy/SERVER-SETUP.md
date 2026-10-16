# Installing the Autoflow Orchestrator on the company server

The Orchestrator is the central part of Autoflow: the web dashboard, the scheduler,
the credential vault and the place robots connect to. It runs as a normal Windows
service. **No Docker, no database server and no compilers are needed.**

## What you need

| | |
|---|---|
| Computer | Windows 10/11 or Windows Server 2019+, 4 GB RAM, 20 GB free disk. Leave it on (no sleep), ideally on a UPS. |
| Software | [Git for Windows](https://git-scm.com/download/win) and [Node.js 24 LTS](https://nodejs.org) |
| Network | A fixed name or address (e.g. `rpa.company.local`); port **8443** reachable from designer PCs and robots |
| Access | A local administrator account on the server; read access to the private GitHub repository |

## 1. Give the server access to the private repository

Pick one:

- **Deploy key (recommended).** On the server run `ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\autoflow`
  and add the `.pub` file in GitHub → repository **Settings → Deploy keys** (read-only).
- **Fine-grained personal access token** with *Contents: Read-only* on this repository only.
  Git asks for it once and stores it in Windows Credential Manager.

## 2. Download and install

Open **PowerShell as administrator**:

```powershell
cd C:\
git clone https://github.com/aly-mohamed-cs/autoflow.git RPA-Server
cd C:\RPA-Server
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\windows\install-server.ps1
```

The script:

1. builds the server and dashboard,
2. creates `C:\RPA-Server\data` (database, screenshots, keys — readable only by Administrators and SYSTEM),
3. creates the credential-vault key and protects it with Windows DPAPI (it only works on this computer),
4. creates a self-signed HTTPS certificate (or imports yours with `-PfxPath company.pfx`),
5. registers and starts the **Autoflow Orchestrator** service (restarts automatically if it stops),
6. opens firewall port 8443 for the domain/private network,
7. schedules a nightly database backup at 02:00 into `data\backups` (last 14 kept).

Options: `-Port 9443`, `-HostName rpa.company.local`, `-PfxPath C:\certs\rpa.pfx`, `-DataDir D:\Autoflow`.

At the end it prints the dashboard address, e.g. `https://rpa.company.local:8443`, and the
certificate fingerprint. **Note the fingerprint** — robots and Studio ask you to confirm it once.

> Using the company's own certificate (from your internal CA) avoids the fingerprint step
> entirely: `.\deploy\windows\install-server.ps1 -PfxPath C:\certs\rpa.pfx`

## 3. First sign-in

1. Open the dashboard address in a browser and create the **administrator** account.
   Keep it as a break-glass account.
2. **Settings → Directory sign-in**: enter the domain controller (`ldaps://dc01.company.local:636`),
   the domain (`company.local`) and the search base (`DC=company,DC=local`). Map Windows groups to
   roles, for example:

   | Autoflow role | Can | Suggested AD group |
   |---|---|---|
   | Administrator | everything, incl. users, robots, settings | `RPA-Admins` |
   | Builder | publish from Studio, manage credentials | `RPA-Builders` |
   | Operator | run automations, schedules, queues | `RPA-Operators` |
   | Viewer | see dashboards and run history | `RPA-Viewers` |

   Use **Test sign-in** with a real account, then **Save**. From now on people sign in with their
   normal Windows username and password.
3. **Credentials**: add the logins robots need (same names as used in Studio).

## Optional: the AI assistant (local model)

Autoflow can use an AI model for *Describe it* drafts, error explanations and fixing failed
steps. It only talks to an **OpenAI-compatible model server on your network**; nothing goes to
the internet. It is off until you set it up.

1. On a machine with enough memory (ideally with an NVIDIA GPU; a CPU works but answers take a
   minute or more), install [Ollama for Windows](https://ollama.com/download) and download a model:
   ```powershell
   ollama pull qwen2.5:7b-instruct      # CPU-friendly; with a GPU try qwen2.5:14b-instruct or larger
   ```
   To reach it from the Orchestrator over the network, set the environment variable
   `OLLAMA_HOST=0.0.0.0` on that machine, restart Ollama and allow port 11434 in its firewall
   (only from the Orchestrator server). LM Studio or vLLM work too.

   Ollama runs while someone is signed in to that machine (it starts from the Startup folder).
   On a dedicated model server, set it to sign in automatically like a robot PC, so the
   assistant is back after a restart. If an NVIDIA GPU makes Ollama crash with a "CUDA error",
   set the environment variable `OLLAMA_LLM_LIBRARY=cuda_v12` and restart Ollama.
2. Dashboard → **Settings → AI assistant (local model)**: turn it on, enter the address
   (`http://<model-server>:11434/v1`) and the model name, then **Save and test**.
3. Builders now see **Describe it** in Studio. Robots ask the model to fix failed steps; each
   working fix waits on the automation's page until a builder keeps or dismisses it. Repair can
   be turned off per automation (automation → **Settings**).

Every AI request is recorded in the audit log. Passwords and values typed into fields are never
sent to the model.

## 4. Updating

When a new version is pushed to GitHub, in PowerShell started with **Run as administrator**:

```powershell
cd C:\RPA-Server
Set-ExecutionPolicy -Scope Process Bypass -Force   # allows scripts in this window only
.\deploy\windows\update-server.ps1                 # add -Installers to also fetch Studio/Robot installers
```

It backs up the database first, pulls the latest code, rebuilds and restarts the service.
Database changes are applied automatically. With `-Installers` the new Studio and Robot packages
land in Downloads, and both update themselves from there: Studio downloads the new version when
it starts and offers **Restart to update** (Settings → Updates shows its status), and robots are
told within a minute and install it as soon as they are idle (see the **Robots** page; turn this
off there if you prefer to choose when, then use **Update now** per robot). Wait until the GitHub
release has finished building before running `-Installers`, or run it again afterwards. If something goes wrong, the previous backup is in
`data\backups`, and `git checkout <previous commit>` + running the script again goes back.

## Day-to-day operations

| Task | How |
|---|---|
| Start / stop | `services.msc` → *Autoflow Orchestrator*, or `Restart-Service AutoflowOrchestrator` |
| Logs | `C:\RPA-Server\data\logs\AutoflowOrchestrator.out.log` |
| Health check | Dashboard → **Server health** (disk, backups, certificate, robots, waiting runs, triggers); for monitoring tools: `https://<server>:8443/health` |
| Tell everyone something | Dashboard → **Settings → Notices**, e.g. planned maintenance; shown in the dashboard and Studio |
| Let another system start automations | Dashboard → **Settings → API keys**; the system sends `Authorization: Bearer <key>` (operator keys start runs and add queue items, viewer keys only read) |
| Watch a robot | Dashboard → **Robots → Screen** (operators and up; recorded in the audit log). To turn it off on a robot, set `"screen_view": false` in its `robot.json` and restart it |
| Backup now | `.\deploy\windows\backup-server.ps1` |
| Restore a backup | Stop the service, copy `data\backups\<date>\autoflow.db` over `data\autoflow.db`, start it |
| Sign-in codes by email | Dashboard → **Settings → Sign-in**: set up the mail server, **Send me a test email**, then ask for a code *for administrators* or *for everyone*. People need an email address (Users; directory users get it from AD) |
| Mail server down, nobody gets a code | `$env:AUTOFLOW_DATA_DIR="C:\RPA-Server\data"; node apps\server\dist\index.js sign-in-codes off` |
| Forgotten admin password | `$env:AUTOFLOW_DATA_DIR="C:\RPA-Server\data"; node apps\server\dist\index.js reset-password admin` |
| Run history retention | 90 days (set `"retentionDays"` in `data\config.json`, then restart) |

### Moving to a new server

Copy the `data` folder **except** `vault.key.dpapi` (it only works on the old computer), install
on the new server, then re-enter the passwords under **Credentials**. Robots must be enrolled again
if the server address changes.
