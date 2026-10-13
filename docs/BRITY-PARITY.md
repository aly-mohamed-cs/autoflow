# Brity RPA parity roadmap

What Brity RPA (v3.1.1 user and admin manuals) offers that Autoflow does not yet, grouped into
releases. Tick items off as they ship. Autoflow keeps its own strengths (sentence-style steps,
self-repairing AI on a local model, robot self-update, no-code formulas) - this list only covers
gaps.

**Deliberately left out** (tell us if any of these matter to you):
- Korea-specific services: Knox Portal, Hancom (HWP), KakaoTalk, Naver.
- Internet Explorer automation (IE is retired; Edge/Chrome are covered).
- Multi-tenant portals and licence management (one company, no licences).
- Cloud AI and cloud office services (Google OCR/Translate, OpenAI, Google Sheets/Docs/Calendar,
  OneDrive): company data stays on-prem; the local AI model covers the AI part.
- Android device automation and process discovery (separate products).

## Release A - designer canvas, sub-processes, coordinates (you asked for these)
- [x] Move steps anywhere on the flowchart (snap to grid); arrows follow; moving a box moves what is in it
- [x] Horizontal / vertical layout switch and **Tidy up**
- [x] Sub-processes (Brity "tasks"): Main + named sub-processes in tabs, **Run sub-process** step with inputs
- [x] Click at X / Y: in the window, on the screen, or offset inside an element; **Pick position** tool
- [x] Mouse: hover, scroll, drag and drop (element or position)

## Release B - designer convenience
- [x] Select several steps (Ctrl+click / box select); copy, cut, paste (also between automations)
- [x] Group steps into a named, collapsible block (Brity "Block" / groups)
- [x] Find a step (Ctrl+F), replace a step with another kind keeping its settings
- [x] Switch / case, Do ... while, Retry these steps N times (RetryTask)
- [x] Checks: "Make sure that ..." (Brity Assert* family) failing with a clear message
- [x] Speed: pause between every step (SetPlayOption); debug console to evaluate formulas while paused
- [x] Message box and input box for attended use

## Release C - screen recognition
- [x] Image recognition: click / double / right-click / hover / type on an image, wait for an image
      to appear or disappear, check an image exists, capture screen / window / region
- [x] Screen OCR: read text in an area, click / hover on a text, wait for a text (works over Citrix/VDI)
- [x] Desktop elements: get position and size, is visible, get checked state, select a menu item,
      invoke an element's default action, read list / grid items, close all windows of a program
- [x] Element inspector: browse a window's element tree and pick from it

## Release D - Excel, Word, PowerPoint, PDF depth
- [x] Excel (live workbook): open / save / close / activate, sheets (add, rename, copy, move, delete),
      clear / copy / paste / merge ranges, colours, borders, number formats, add / delete / hide rows
      and columns, formulas (read / write), find and replace, AutoFilter, run a macro, split a workbook
- [x] Word: new / open, insert text, replace text, read text, save (also as PDF)
- [x] PowerPoint: open, slides (count, add, delete, copy), save
- [x] PDF: search text, pages to images, extract images

## Release E - system and integrations
- [x] Run a command / PowerShell / Python script (admins decide who may use it)
- [x] Clipboard get / set; special folders (Desktop, Documents, Downloads, Temp); open a file with its program
- [x] Wait until a file is unlocked / deleted; registry read / write; encrypt / decrypt; Base64
- [x] JSON: read a value, convert to / from text; XML: read by XPath
- [x] Email: reply, forward, delete, mark read (Exchange) - Outlook desktop is not planned: robots use the mail server directly
- [x] SSH commands; FTP / SFTP upload / download / list / delete
- [x] Notifications: Teams / Slack / generic webhook message
- [x] AI step (local model): classify, extract fields, summarise, translate; detect language through "Do what I write"

## Release F - Orchestrator
- [x] Shared resources (assets): company-wide values and files that automations read at run time
- [x] Queue steps inside automations: add item, get next item, mark done / failed, count; "For each queue item" loop
- [x] Event triggers: new email arrives, file appears in a folder (watched by a robot of the pool)
- [x] Process flows: chain automations (when A succeeds / fails / finishes, start B with A's results); waiting for an event = event triggers
- [ ] Live robot screen view and remote stop from the dashboard
- [ ] Notices for users; API keys for the REST API; email two-factor sign-in; server health page
- [ ] Attended "work plans": users run and schedule their own automations from a tray list

## Release G - enterprise apps
- [ ] SAP GUI: wait for screen, grids and tables (read, select, set), trees, status bar, combo boxes, run script
