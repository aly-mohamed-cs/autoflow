# Autoflow user guide

Autoflow lets you hand repetitive computer work to a robot: typing rows from Excel into a
website or program, downloading and combining reports, reading invoices, sending emails.
You build an **automation** once in **Autoflow Studio**, test it on your own PC, then
**publish** it so a robot runs it — whenever you want, on a schedule, or when other systems ask.

No programming is needed. If you can describe the task step by step, you can automate it.

---

## 1. Your first automation in 10 minutes

1. Open **Autoflow Studio** and click **New automation**. Give it a clear name, such as
   “Enter vendor invoices into the portal”.
2. Pick a **template** that looks like your task, or start from scratch.
3. Add steps from the **library on the left** — click to add, or drag them onto an arrow in the
   flowchart. Each **＋** on an arrow adds a step at that point. The flow reads left to right
   from **Start** to **End**: an *If* splits into **Yes** / **No** paths that join again, and a
   loop is a box around the steps it repeats. Each step reads like a sentence:
   *Type **Invoice No** into **Invoice number box***. Scroll to move around, Ctrl+scroll to zoom.
   **Drag a step** to place it anywhere (it snaps to a grid; moving a loop or an *If* moves
   what is in it). The order stays the one the arrows show — to change the order, let go of
   the step on a **＋**. The arrows **→ / ↓** at the top switch between left to right and top
   to bottom; **Tidy up** puts everything back in neat rows. Prefer a plain list (handy for
   long recordings)? Switch **Flow / List**.
4. Click a step to fill in its settings on the right. Red settings still need a value.
5. Press **Test run**. Watch each step turn green, see the log at the bottom, and check the
   **Variables** tab to see what the automation read.
   **Pause** and **Stop** work at any moment, also while a step is waiting for a window or a
   page. When the automation works in another program, Studio is behind it: use the small bar
   at the top of the screen, or the keys **Ctrl+Shift+F11** (pause / continue) and
   **Ctrl+Shift+F12** (stop) from any program.
6. When it works, press **Publish**. It now appears in the dashboard, ready for robots.

> **Tip — let Autoflow watch you.** Press **Record** and choose:
> * **Anything on this PC** — Studio steps aside; do the task in any program (Excel, your ERP,
>   File Explorer, a browser…). A red bar at the top of the screen shows it's recording; click
>   **Stop recording** there when you're done. Clicks, what you type into boxes, choices in lists,
>   ticks, keyboard shortcuts (like Ctrl+S) and switching between programs become steps. Programs
>   you open during the recording get an "Open application" step.
> * **A website** — enter the address and do the task in the browser that opens (best for web
>   portals).
>
> Passwords are never recorded; you choose a saved credential instead. Programs started "as
> administrator" can't be recorded.

---

## 2. The ideas you need

| Idea | What it means |
|---|---|
| **Step** | One action: open a website, click a button, read an Excel sheet, send an email. |
| **Element** | Something on a screen a step works with — a button, a box, a table. You **pick it on screen** instead of describing it. |
| **Variable** | A named value the automation remembers, e.g. the table read from Excel. Blue chips like **row › Invoice No** are variables. |
| **Start value** | A variable filled in when the automation starts, such as *which Excel file to process*. |
| **Credential** | A saved username and password. Robots get it only while they run an automation that needs it, and it never appears in logs. |
| **Sub-process** | A named part of an automation in its own tab (like Brity RPA *tasks*), e.g. “Log in to ERP”. A **Run sub-process** step runs it — from as many places as you like. |

### Using values from earlier steps

In any text box, click **{ }** (or type **{**) and choose a variable. For a column of the row
you are processing, choose e.g. **row › Customer**. You never need to type special syntax.

Need a calculation? Choose **Write a formula…** — it works like Excel:
`ROUND(row["Total"] * 1.14, 2)`, `IF(amount > 1000, "High", "Normal")`, `FORMATDATE(TODAY(), "DD/MM/YYYY")`.
The preview shows the result using values from your last test run.

---

## 3. Common tasks

### Process every row of an Excel sheet
1. **Read Excel sheet** → saves a table (e.g. `rows`).
2. **For each** → *For each row in rows*. Put the steps for one row inside.
3. To write a result back: **Update Excel row** with *Row number* = the loop's position
   counter (**row_number**).

### Work in a website
* **Open browser** with the address, then **Type text**, **Click**, **Choose from dropdown**…
* For each step, press **Pick on screen** and click the element in the browser that opens.
  Need to sign in first? Hold **Ctrl** while clicking to use the page normally.
* Pages often take a moment: use **Wait for element** instead of a fixed wait.
* **Extract table from page** copies a table into Autoflow; **Download file** saves exports.
* Downloads: use **Download file** on the export link or button. It waits until the file is
  completely downloaded, keeps the website's own name (in the Downloads folder unless you choose
  another one), and its result (**downloaded_file**) is the file for the next steps, e.g. **Read
  Excel file**. Tick **Open the file when the download has finished** to open it in Excel.
  A recorded click that downloads something becomes **Download file** by itself.
* The browser opens as a normal window (not a private one) and saves downloads itself, as when you
  click by hand: its download list opens the file. A plain **Click** that starts a download also
  lands in Downloads; add **Wait for file** after it. A file with the same name is replaced.
* If a website calls an Excel file `.xls` but it is really `.xlsx`, Autoflow gives it the right
  extension, so Excel opens it without a "format and extension don't match" warning. Excel shows
  its yellow *Protected View* bar for any downloaded file (Windows marks it as coming from the
  internet); Autoflow's Excel steps read the file anyway.

### Work in a Windows program (ERP, accounting…)
* **Open application** starts it and waits for its window.
* **Pick on screen**: switch to the program, point at the box or button, press **Ctrl**.
  A red outline shows what will be picked.
* After saving something, **Wait for element in application** → *text contains* (e.g. “Saved”)
  before reading the result.

### Work faster in the designer
| Do this | How |
|---|---|
| Select several steps | **Ctrl+click** them, or hold **Shift** and drag a box on an empty spot. **Ctrl+A** selects all. |
| Copy / cut / paste | **Ctrl+C**, **Ctrl+X**, **Ctrl+V** — also between automations (Studio windows or other PCs: it is plain text). |
| Put steps in a named box | Select them, **Ctrl+G** (or **Group into a box**). Click **⌄** on any box to fold it away. |
| Find a step | **Ctrl+F**, type what it does (e.g. *save*), **Enter**. |
| Turn a step into another kind | The **⇄** button at the top of its settings. Settings that still apply are kept. |
| Check a value while testing | Press **F9** on a step to pause there, start **Test run**, open **Console** and type a formula. |
| Slow a run down | **Pause after every step** in the automation's settings (click an empty spot). |

### Connect steps your way (free connections)
New automations start with **Free connections** on (the switch above the flowchart): the
steps run in the order you connect them, from **Start**.

* **Connect**: drag from the dot on the right of a step (or of Start) to another step.
  Dragging from a dot to an empty spot adds a new step there, already connected.
* **Leave a step on its own**: a step nothing leads to shows **not connected** and does not
  run. Drop a step from the library onto an empty spot to add it unconnected.
* **Disconnect**: point at a connector and click **×**. The **+** on a connector adds a step
  in between.
* Clicking a step in the library connects it after the selected step (or to Start, if
  nothing is connected to Start yet).
* **Decision**: two ways out, a green **Yes** and a red **No**. Connect **No** back to an
  earlier step to repeat steps until something is true (a run that never ends this way is
  stopped after 100,000 steps).
* What is inside a loop, If or Try box still runs in order. **Tidy up** lines everything up in
  the order it runs. Turning the switch off puts the steps one after the other again, once
  they are all connected in one line.
* Robots run free connections once they have the release that adds them (they update themselves).

### Choose between several paths, retry, check
* **Switch / case** — one path per value (e.g. *Paid*, *Overdue*) plus **Otherwise**. Add cases in its
  settings; each gets its own lane.
* **Do … while** — like *Repeat while*, but the steps always run at least once.
* **Retry steps** — runs the steps inside again from the first one when one fails (e.g. a log-in
  that sometimes times out).
* **Make sure that** — stops with your own clear message when something is not as expected.
* **Show message** / **Ask for a value** — for automations someone watches. Set **Close by itself
  after** for robots nobody watches.

### Click at a position (X, Y)
Some things have no button the recorder can see — drawings, maps, charts, remote desktops.
* **Click at position** clicks a point measured from the top-left corner of a window (or of the
  whole screen). Press **Pick position**, point at the spot and press **Ctrl**: the position and
  the window are filled in for you.
* A normal **Click** can also aim at a **Point inside the element** (e.g. the arrow at the right
  end of a box) instead of its centre.
* Also: **Point at element** (hover), **Move mouse to position**, **Scroll**, **Drag and drop**
  and **Drag between positions** (sliders, drawings).
* Positions depend on window size and screen scaling: prefer picked elements where you can.

### Work in SAP
The **SAP** steps work in SAP GUI for Windows through SAP GUI Scripting, so your SAP team must
allow scripting (on the server: `sapgui/user_scripting`; in SAP GUI: *Options → Accessibility &
Scripting*).

1. **Attach to SAP**: use the SAP window that is open, or open a connection from SAP Logon and log
   on with a saved credential.
2. **Start SAP transaction** (e.g. *VA01*), **Type in SAP field**, **Select in SAP** (dropdowns,
   checkboxes, tabs), **Press SAP button or key** (Enter, Save, Execute…), **Read SAP field**.
3. **Read SAP table** gives all rows of an SAP list as a table; **Work with SAP table** selects
   rows, double-clicks a cell or presses a button of the list's toolbar. **Work with SAP tree**
   opens nodes by their names, e.g. *Favorites/Sales/VA01*.
4. After pressing a button or key, the step waits until SAP is done and **stops if the status bar
   shows an error** (switch that off under *More options*). **Read SAP status bar** gives the
   message, e.g. the new order number.

Every SAP field has an id like `wnd[0]/usr/ctxtVBAK-AUART`. The easy way to get it: click into the
field in SAP, then press **Use the SAP field that has the cursor** under the id in Studio. SAP's
own script recorder (*Customize Local Layout → Script Recording and Playback*) shows ids too, and
its recordings can be played with **Run SAP GUI script** (administrators publish those).

### Programs without controls (remote desktops, Citrix, charts)
When **Pick on screen** can't see a button, work with what is drawn on the screen (**Screen** steps):
* **Click image** / **Point at image** / **Wait for image** / **Is image on screen** — press
  **Capture**: Studio steps aside, the screen freezes and you draw a box around the button or icon.
  It is found even when the other PC scales its screen a little differently.
* **Read text on screen**, **Click text on screen**, **Wait for text on screen** — text
  recognition (OCR), fully offline. **Only this part** → **Pick area** limits it to a box.
* **Take screenshot** saves the screen, a window or part of it as a picture.

More for Windows programs: **Choose menu item** (*File > Save as*), **Read list items**,
**Get element details** (position, size, enabled, ticked, value), **Does element exist** and
**Close program**. Hard to point at a control? In its element box choose
**Browse a program's controls…** and pick it from the window's tree.

### Split a big automation into sub-processes
1. Click **＋ Sub-process** above the steps and name it, e.g. *Log in to ERP*.
2. Build its steps in its tab. Need a different value each time (which user, which file)?
   Click an empty spot and add **Inputs**.
3. In the main process (or another sub-process), add **Run sub-process**, choose it and fill
   in its inputs. Sub-processes use the same variables as the rest of the automation.

### More with Excel, Word and PowerPoint (no Office needed)
* **Excel:** add / rename / copy / delete sheets, **Format cells** (bold, colours, number format,
  borders, column width), **Merge cells**, insert / delete / hide rows and columns, **Copy cells**
  (formulas follow), **Find and replace**, **Add filter buttons**, **Read cell formula**, and
  **Split sheet into files** (e.g. one workbook per region).
* **Word:** **Create Word document** (from a template), **Add text** / **Add table**, **Replace
  text** to fill in a template (placeholders like `[Customer]`), **Read Word document**.
* **PowerPoint:** **Add slide**, **Delete slide**, **Replace text**, **Count slides**, **Read**.
* These need Office on the computer that runs them: **Run Excel macro**, **Recalculate Excel**
  (fresh formula results and data connections) and **Save Office file as PDF**.

### Read invoices and other PDFs
* **Get fields from PDF**: for each field, enter the label printed before it
  (e.g. `Invoice No:`) and what kind of value it is (text, number, date…).
* **Extract table from PDF** reads item lines. Scanned PDFs are read automatically with
  text recognition (OCR).
* **Search PDF** tells on which pages a text is; **PDF pages to pictures** and **Save pictures in
  a PDF** save PNG files.

### Email
* **Send email** through the company mail server, with attachments such as a report.
* **Read emails** gets messages from a mailbox as a table; **Save email attachments**
  stores e.g. PDF invoices for the next steps.
* **Reply to email** and **Forward email** answer a message you got from **Read emails**
  (keep the conversation, add attachments). **Mark or delete email** marks it read or unread,
  or moves it to Deleted Items.

### Tell people in Teams or Slack
**Send Teams or Slack message** posts to a channel. Ask your Teams or Slack administrator for
the channel's *incoming webhook* address and save it as a **credential** (the address goes in
the password box) - whoever has the address can post to the channel, so it never goes in a
step.

### Files on other servers (FTP, SFTP, SSH)
* **List files on server**, **Download from server**, **Upload to server** and **Delete file on
  server** work with FTP, FTPS (encrypted FTP) and SFTP. The user name and password come from a
  credential.
* **Run command over SSH** runs a command on a Linux or Unix server and gives back what it
  printed.

### Windows, clipboard and data from other systems
* **Get special folder** gives the path of Desktop, Documents, Downloads or Temp for the user
  the automation runs as - better than typing `C:\Users\...` into steps.
* **Get clipboard text** / **Set clipboard text**, **Open file with its program** (like
  double-clicking it), **Read registry value**.
* **Wait until file is free** waits until another program has finished writing a file (or
  until the file is gone) before the next step uses it.
* **Read JSON** takes a value out of an API answer by its path, e.g. `order.items[0].price`; a
  list of records becomes a table. **Make JSON** turns values or a table into JSON text.
  **Read XML** finds values with an XPath such as `//invoice/total`.
* **Encrypt text** / **Decrypt text** protect a text with a key kept in a credential;
  **Base64** converts to and from Base64.

### Values shared by many automations, and work queues
* **Shared values** (dashboard → **Shared values**) keep things several automations need, such
  as a portal address, an approval limit or a price list file. **Get shared value** reads one
  while the automation runs, so a change is made once, in the dashboard. Passwords belong in
  **Credentials**, not here.
* **Queues** split work between runs and robots. **Add queue item** puts work in a queue, e.g.
  one item per invoice row (choose *Or a whole row* to take all its columns).
  **For each queue item** works through a queue: the steps inside run for each waiting item,
  which is then marked done. If a step fails, the item is marked failed (or set to be tried
  again later) and the loop goes on with the next one. For more control use **Get next queue
  item** and **Finish queue item**; **Count queue items** tells how many are waiting.
* In Studio these steps need a connection to the Orchestrator (**Settings**). They work on the
  real queue; items a test run took but didn't finish go back to the queue when it ends.

### Commands and scripts (administrators decide)
**Run command** (Command Prompt or PowerShell), **Run Python script**, **Write registry value**
and **Run command over SSH** can do anything on the machine, so they show an **admin** badge in
the step library. You can build and test with them, but **only an administrator can publish**
an automation that uses them - unless an administrator allows builders to under **dashboard →
Settings → Security**. Disabled steps don't count.

### When something can go wrong
* Every step has **If this step fails**: try again a few times, or continue anyway.
* Put risky steps inside **Try / If it fails** to run other steps when they fail
  (e.g. move the file to a “failed” folder and continue with the next one).

---

## 4. Running automations without you

Open the **dashboard** (address from your administrator) and choose the automation. If your
company turned on sign-in codes, you get a 6-digit code by email after your password (also
when you connect Studio); it works for 10 minutes.

| You want it to run… | Do this |
|---|---|
| Now | **Run now**, fill in the start values |
| On a schedule | **Schedules → Add a schedule**, e.g. *Every weekday at 08:00* |
| When another system asks | **Webhooks → Create webhook**; give the address to IT |
| For many separate items | Create a **Queue**, add items (paste rows from Excel); each item gets its own run |
| With a keyboard shortcut | In Studio: **Settings → Quick launch**, e.g. *Ctrl+Alt+1* |
| When a file appears in a folder | **Event triggers → When a file appears** |
| When an email arrives | **Event triggers → When an email arrives** |
| After another automation | On the other automation: **Then start**, e.g. when it succeeds or fails |

Every run is kept in **Runs** with each step, the log and screenshots — open a failed run to
see exactly where and why it stopped.
To see what a robot is doing right now, open **Robots → Screen**: its screen, refreshed every
second or two, with **Stop the run** if something goes wrong.

**Event triggers** are watched by a robot of the pool you choose, so that robot must be able to
open the folder (e.g. `\\fileserver\scans`) or sign in to the mailbox. Each new file or email
starts one run; a file counts once it has been completely copied in. Files and emails that were
already there when you created the trigger don't count, unless you ask for them. To use the file
or email in the steps, give the automation the start value (Studio → **Start values & variables**):

* `trigger_file` (the full path) or `trigger_file_name` for a folder trigger;
* `trigger_email` for an email trigger: `{{trigger_email["subject"]}}`, `["from"]`, `["text"]`,
  `["attachments"]` (file names). To save its attachments, use **Read emails** with **Only this
  message** set to `{{trigger_email["id"]}}`, then **Save email attachments**.

**My work plan** (Studio) is for automations you run yourself, on **your own PC**: add a
published automation, then **Run on this PC**, start it from the tray icon next to the clock, or
give it a schedule (every day, Monday to Friday, or every few minutes) — it runs while Studio is
open, also when its window is closed. It uses the credentials saved in Studio on this PC, and the
**Pause / Stop** keys work as in a test run. A time that passes while Studio is closed is skipped.

**Then start** chains automations. With *hand over results*, the next automation gets this
one's results as start values with the same names, and `previous_run` (its automation, status,
error) if it has such a start value. A person stopping a run doesn't start the next one.

---

## 5. The AI assistant (if your company turned it on)

Your administrator can connect Autoflow to an AI model that runs **on the company's own
network** — nothing is sent to the internet. When it is on you get:

* **The AI assistant chat** (editor toolbar → **AI assistant**, or **Build with AI** on the
  Automations page for a new one): talk with the assistant and it changes the automation for
  you.
  * Describe the job in plain words, e.g. *“Open the invoices Excel file, type each row into
    the vendor portal and save the reference number back”*. The assistant picks the steps,
    fills in their settings, adds variables and connects the steps (also with free
    connections).
  * Keep talking to change it: *“If a row fails, log it and continue”*, *“Read the file from
    the Reports folder instead”*, *“Explain what this automation does”*.
  * Each answer lists what changed, with **Undo**. Studio checks the new steps and lets the
    assistant fix its own mistakes (a wrong formula, a variable that's never set) before you see
    them; what only you can do is listed under **Still to do** — click a line to go to the step,
    e.g. to pick a screen element with *Pick on screen* or enter a web address.
  * It never sees passwords or the text your automation types into screens. Always test what
    it builds before publishing; it can be wrong.
* **Explain this error**: on a failed step (Studio) or a failed run (dashboard), the assistant
  explains in plain words what probably went wrong and what to change.
* **The AI step** (**Ask the AI assistant**, in the *AI* group of the step library) lets an
  automation use the model on a text it has read - an email, a PDF, a cell:
  * **Choose a category**: e.g. *Invoice*, *Complaint*, *Order* - the answer is always exactly
    one of them, ready for a **Switch** step.
  * **Pull out fields**: e.g. *Invoice number*, *Total*, *Due date* - the answer has one value
    per field (empty when the text doesn't have it).
  * **Summarise**, **Translate**, or **Do what I write** (e.g. *“Write a polite two-line reply”*
    or *“Which language is this?”*).
  * The answer is saved in a variable (*ai_answer* unless you choose another). It works in test
    runs and on robots; check important values before you rely on them, as a model can be wrong.
* **Fixing failed steps by itself**: when a step fails — a button was renamed, a file or sheet
  has a different name — the assistant looks at what is on the screen, adjusts **only that
  step** and tries it again (up to 3 times). The run continues from that step, so nothing that
  was already done is done twice.
  * In a **test run** you see a card *“The AI assistant fixed … and it worked”* with what it
    changed. Choose **Keep fix** to update your automation, or **Discard**.
  * On **robots**, the fix is used for that run only. The automation shows *“AI fix to review”*
    in the dashboard; a builder chooses **Keep fix (publish a new version)** or **Dismiss**.
    Automations never change without a person approving it.
  * Turn it off per automation in the dashboard (**Settings → Let the AI assistant fix failed
    steps on robots**) or for your test runs in Studio (**Settings → AI assistant**).

When it fixes a failed step, what it may change is deliberately limited to **how a step finds
things**: which element on the screen, how long to wait, which sheet or column, and which file
to *read*. It never changes
web addresses, the values that are typed or written, where results are saved, or credentials,
and it never touches steps that use a password. It never sees passwords or what was typed into
fields.

---

## 6. Good habits

* **Test with real data** before publishing; robots do exactly what you publish.
* **Name things clearly** — automations, elements and variables. Colleagues will thank you.
* **Prefer waiting for something** over fixed waits — it is faster and more reliable.
* **Keep secrets in credentials**, never in steps or Excel files.
* Fill in **Minutes saved per run** (dashboard → automation → Settings) to see the time you
  save on the overview page.

Questions? Your Autoflow administrator can see the audit log and run history to help.
