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
3. Add steps from the **library on the left** — drag them into the list, or click to add.
   Each step reads like a sentence: *Type **Invoice No** into **Invoice number box***.
4. Click a step to fill in its settings on the right. Red settings still need a value.
5. Press **Test run**. Watch each step turn green, see the log at the bottom, and check the
   **Variables** tab to see what the automation read.
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

### Work in a Windows program (ERP, accounting…)
* **Open application** starts it and waits for its window.
* **Pick on screen**: switch to the program, point at the box or button, press **Ctrl**.
  A red outline shows what will be picked.
* After saving something, **Wait for element in application** → *text contains* (e.g. “Saved”)
  before reading the result.

### Read invoices and other PDFs
* **Get fields from PDF**: for each field, enter the label printed before it
  (e.g. `Invoice No:`) and what kind of value it is (text, number, date…).
* **Extract table from PDF** reads item lines. Scanned PDFs are read automatically with
  text recognition (OCR).

### Email
* **Send email** through the company mail server, with attachments such as a report.
* **Read emails** gets messages from a mailbox as a table; **Save email attachments**
  stores e.g. PDF invoices for the next steps.

### When something can go wrong
* Every step has **If this step fails**: try again a few times, or continue anyway.
* Put risky steps inside **Try / If it fails** to run other steps when they fail
  (e.g. move the file to a “failed” folder and continue with the next one).

---

## 4. Running automations without you

Open the **dashboard** (address from your administrator) and choose the automation:

| You want it to run… | Do this |
|---|---|
| Now | **Run now**, fill in the start values |
| On a schedule | **Schedules → Add a schedule**, e.g. *Every weekday at 08:00* |
| When another system asks | **Webhooks → Create webhook**; give the address to IT |
| For many separate items | Create a **Queue**, add items (paste rows from Excel); each item gets its own run |
| With a keyboard shortcut | In Studio: **Settings → Quick launch**, e.g. *Ctrl+Alt+1* |

Every run is kept in **Runs** with each step, the log and screenshots — open a failed run to
see exactly where and why it stopped.

---

## 5. The AI assistant (if your company turned it on)

Your administrator can connect Autoflow to an AI model that runs **on the company's own
network** — nothing is sent to the internet. When it is on you get:

* **Describe it** (Studio → Automations): write what the automation should do in plain words,
  e.g. *“Open the invoices Excel file, type each row into the vendor portal and save the
  reference number back”*. The assistant drafts the steps. Fill in what it can't know (web
  addresses, pick the screen elements), then test it as usual.
* **Explain this error**: on a failed step (Studio) or a failed run (dashboard), the assistant
  explains in plain words what probably went wrong and what to change.
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

What it may change is deliberately limited to **how a step finds things**: which element on
the screen, how long to wait, which sheet or column, and which file to *read*. It never changes
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
