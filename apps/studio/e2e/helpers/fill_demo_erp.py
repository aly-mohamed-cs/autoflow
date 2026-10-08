"""Act like a person in the demo ERP (real mouse and keyboard) while Studio records the PC.

    python fill_demo_erp.py <path to DemoErp.exe>
"""

import subprocess
import sys
import time

import uiautomation as auto

app = subprocess.Popen([sys.argv[1]])
try:
    window = auto.WindowControl(searchDepth=1, SubName="Demo ERP")
    if not window.Exists(15):
        sys.exit("Demo ERP did not open")
    window.SetActive()
    time.sleep(0.8)
    for box, text in (("txtCustomer", "Initech"), ("txtInvoice", "INV-77"), ("txtAmount", "10")):
        window.EditControl(AutomationId=box).Click(simulateMove=False)
        time.sleep(0.3)
        auto.SendKeys(text, waitTime=0.05)
        time.sleep(0.3)
    window.ButtonControl(AutomationId="btnSave").Click(simulateMove=False)
    time.sleep(2)
finally:
    app.kill()
